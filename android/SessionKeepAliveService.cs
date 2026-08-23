using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.OS;
using Slopterm.Server;

namespace Slopterm.Mobile;

// Keeps the app's process running normally for a few minutes after the user switches away,
// so the SSH connections it holds stay up. It exists only while both halves of that sentence
// hold: there is something live to keep, and the app is genuinely in the background.
//
// The problem this solves is not battery policy, which is why setting slopterm to
// "unrestricted" background energy usage doesn't help: an app with no visible Activity and no
// service has no foreground component at all, so it drops to the cached-app state, and from
// Android 12 the platform freezes cached processes outright (SIGSTOP on every thread) within
// seconds. Frozen means Kestrel, SSH.NET's transport reader and the shell pumps all stop dead
// - nobody answers the server's keepalives, nobody drains the sockets - and the connections
// are reaped from the other end. The battery allowlist governs Doze and App Standby buckets;
// it has no bearing on the freezer or on how eagerly lmkd kills the process, both of which key
// on process state. A foreground service is the supported way to change process state, and
// this is the smallest one that does the job: it exists only while it's needed, and it stops
// itself.
//
// The notification is the visible cost of that, and it should only ever be seen when it's
// buying something: connections open, app not on screen. Neither condition can be settled at
// the moment the service starts. Connections are checked by MainActivity before it starts us
// at all and re-checked below as they come and go; being in the background can't be checked
// yet at all, because the only hook allowed to start a foreground service (OnPause) fires
// before the app is one - a dialog or a picker pauses the Activity exactly the same way. So
// the promotion here is provisional: it happens immediately, because Android requires it
// within about five seconds of the start, and is withdrawn again if OnStop doesn't follow
// shortly after (see WaitForBackgroundAsync). On Android 12+, which holds a foreground-service
// notification back for ten seconds before drawing it, that withdrawal beats the draw and
// nothing is ever shown.
//
// What it cannot be is absent: an app cannot hold a foreground service without a notification,
// so the only thing actually on the table is how loudly it's presented - which is what the two
// channels below are for. A client that appears to keep connections open with no notification
// at all is either doing what the quiet channel here does (Min importance: silent, sorted to
// the bottom, collapsed out of the shade, no badge) or simply running without the
// POST_NOTIFICATIONS permission, which is the user's to grant or deny in the system settings
// and costs nothing either way - the service still runs and the connections still survive.
//
// It is deliberately short-lived, and the cap below is what "keep connections open for a few
// minutes in the background" actually means. Note that while this service is running the
// WebView usually keeps its terminal WebSocket open too, so the backend's own five-minute
// detach grace never even starts counting - that grace is for a socket that was lost, not for
// an app that stepped away. The two mechanisms are complementary, not a handoff.
//
// When the cap expires the process goes back to being cached and is frozen as before; the
// connections then rot as the far end times them out. That's the intended end of the window,
// and it isn't silent: the session's reader sees the transport fail and reports it as a lost
// connection, so the tab reconnects when the user returns instead of vanishing.
//
// Type: dataSync. A live SSH/SFTP channel is a data transfer, it's the standard type Google
// Play accepts with no declaration form, and it's what the [Service] attribute can emit
// directly. specialUse would need a hand-written <service> block (the attribute can't emit
// the required <property> child element) plus a written Play justification; connectedDevice
// is for Bluetooth/USB/companion hardware, not a host reachable over IP.
[Service(
    Name = "com.gwdevhub.slopterm.SessionKeepAliveService",
    Exported = false,
    ForegroundServiceType = ForegroundService.TypeDataSync)]
public sealed class SessionKeepAliveService : Service
{
    private const int NotificationId = 2;

    // Two channels rather than one reconfigured on the fly, because a channel's badge and
    // importance are fixed at creation: the platform ignores both fields on a channel that
    // already exists (and recreating a deleted id restores the old values), so the only way to
    // honor the setting is to post on a different channel. The quiet one is the default and
    // takes the importance all the way down to Min, which is as close to Termius' "no
    // notification" as an app is allowed to get from the inside - Android still requires a
    // notification for the foreground service that keeps the connections alive, but a Min
    // channel is silent, sorted to the bottom, collapsed by the shade, and badges nothing.
    private const string QuietChannelId = "slopterm_sessions_quiet";
    private const string BadgeChannelId = "slopterm_sessions_badge";

    // Superseded by the pair above, which differ from it in badge/importance. Deleted on the
    // way past so upgrading installs don't leave a dead entry in the app's notification
    // settings - the user never chose it, so there's nothing of theirs to preserve.
    private const string LegacyChannelId = "slopterm_sessions_channel";

    // The whole point of the exercise: how long connections survive the user switching apps.
    // Bounded so a forgotten app can't hold a wake-worthy service (and a notification) all
    // day; generous enough to cover looking something up elsewhere and coming back.
    private static readonly TimeSpan MaxLifetime = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(20);

    // How long to wait for MainActivity.OnStop after the OnPause that started us, before
    // concluding the app isn't going anywhere (see WaitForBackgroundAsync). Under the ten
    // seconds Android 12+ defers a foreground-service notification by, so on those versions
    // the notification of a service that gives up here is never drawn at all; comfortably
    // over the sub-second OnPause -> OnStop gap of a real app switch.
    private static readonly TimeSpan BackgroundGrace = TimeSpan.FromSeconds(8);
    private static readonly TimeSpan BackgroundPollInterval = TimeSpan.FromMilliseconds(250);

    private CancellationTokenSource? _stopWatch;

    public override IBinder? OnBind(Intent? intent) => null;

    public override StartCommandResult OnStartCommand(Intent? intent, StartCommandFlags flags, int startId)
    {
        // Android gives roughly five seconds between the start and this call before it kills
        // the app for not promoting itself, so this path stays free of any I/O.
        try
        {
            StartInForeground();
        }
        catch (Java.Lang.Exception)
        {
            // Promotion refused (a background-start restriction we didn't anticipate). Better
            // to go away quietly than to sit here as a service the platform won't honor.
            StopSelf();
            return StartCommandResult.NotSticky;
        }

        _stopWatch ??= StartSelfStopWatch();

        // NotSticky: if the platform does kill us, the sessions died with the process, so
        // there's nothing left worth restarting for.
        return StartCommandResult.NotSticky;
    }

    private void StartInForeground()
    {
        var count = LiveSessionCount();
        var text = count == 1 ? "Keeping 1 connection open" : $"Keeping {count} connections open";

        // Tapping it comes back to the app rather than doing nothing. Immutable because
        // nothing else is meant to rewrite it, which Android 12+ requires us to state.
        var contentIntent = PendingIntent.GetActivity(
            this,
            0,
            new Intent(this, typeof(MainActivity)).SetFlags(ActivityFlags.SingleTop),
            PendingIntentFlags.Immutable | PendingIntentFlags.UpdateCurrent);

        // Off by default: this notification is a requirement of running in the foreground, not
        // something the user asked to be told about, so it shouldn't also mark the launcher
        // icon. Settings turns it back up for anyone who wants to see at a glance that
        // connections are being held (see AppSettings.SessionNotificationBadge).
        var badge = MainActivity.SessionNotificationBadgeEnabled;

        Notification.Builder builder;
        if (OperatingSystem.IsAndroidVersionAtLeast(26))
        {
            // Low even when badging: no sound and no heads-up either way, the setting only
            // decides how visible the thing is once it's in the shade.
            var manager = (NotificationManager?)GetSystemService(NotificationService);
            manager?.DeleteNotificationChannel(LegacyChannelId);
            var channelId = badge ? BadgeChannelId : QuietChannelId;
            var channel = new NotificationChannel(
                channelId,
                "Active sessions",
                badge ? NotificationImportance.Low : NotificationImportance.Min)
            {
                Description = "Shown while slopterm is holding connections open in the background",
            };
            channel.SetShowBadge(badge);
            manager?.CreateNotificationChannel(channel);
            builder = new Notification.Builder(this, channelId);
        }
        else
        {
#pragma warning disable CA1422 // the channel-less builder is the correct one below API 26
            builder = new Notification.Builder(this);
            // Pre-channel, priority is the only knob: Min keeps it out of the status bar
            // entirely (shade only), Low merely keeps it quiet.
            builder.SetPriority((int)(badge ? NotificationPriority.Low : NotificationPriority.Min));
#pragma warning restore CA1422
        }

        // Called as statements rather than chained: every one of these returns
        // Notification.Builder? in the bindings, so a fluent chain is a string of
        // dereferences the compiler can't prove safe. They all mutate and return the same
        // builder, so discarding the result costs nothing.
        builder.SetSmallIcon(Resource.Drawable.ic_launcher);
        builder.SetContentTitle("slopterm");
        builder.SetContentText(text);
        builder.SetContentIntent(contentIntent);
        builder.SetOngoing(true);
        builder.SetOnlyAlertOnce(true);
        var notification = builder.Build();

        if (OperatingSystem.IsAndroidVersionAtLeast(29))
        {
            StartForeground(NotificationId, notification, ForegroundService.TypeDataSync);
        }
        else
        {
            StartForeground(NotificationId, notification);
        }
    }

    // Stops as soon as either of the two conditions that justify this service stops holding -
    // the app came back to the foreground, or there's nothing left to keep alive - and in any
    // case at the hard cap. The count can reach zero while backgrounded - a shell exits on its
    // own, a forward fails - and the notification goes away as soon as it does rather than
    // sitting out the rest of the window.
    //
    // Note this never runs long enough to meet Android 15's six-hours-per-day dataSync budget,
    // which is why Service.OnTimeout isn't implemented - the cap above is two orders of
    // magnitude below it.
    private CancellationTokenSource StartSelfStopWatch()
    {
        var cts = new CancellationTokenSource();
        var token = cts.Token;
        _ = Task.Run(async () =>
        {
            var deadline = DateTimeOffset.UtcNow + MaxLifetime;
            try
            {
                // Nothing below runs at all if the app never actually went away: the service
                // stops again with its notification still undrawn.
                while (await WaitForBackgroundAsync(token) && !token.IsCancellationRequested)
                {
                    await Task.Delay(PollInterval, token);
                    // This is a background thread, so it's the safe place to do the one part
                    // of the count that can block (see MainActivity.RefreshForwardCount).
                    MainActivity.RefreshForwardCount();
                    if (LiveSessionCount() > 0 && DateTimeOffset.UtcNow < deadline)
                    {
                        continue;
                    }

                    break;
                }
            }
            // Qualified: Android.OS has an OperationCanceledException of its own, and
            // `using Android.OS;` above makes the bare name ambiguous with System's.
            catch (System.OperationCanceledException)
            {
                return;
            }

            if (!token.IsCancellationRequested)
            {
                // StopSelf has to happen on the main thread's looper for the service teardown
                // callbacks to run where Android expects them.
                new Handler(Looper.MainLooper!).Post(() =>
                {
                    StopForeground(StopForegroundFlags.Remove);
                    StopSelf();
                });
            }
        }, token);
        return cts;
    }

    // True once the app is actually in the background with something worth holding open, false
    // if it turns out not to be going anywhere. Both conditions have to hold for this service
    // to be justified, and only one of them is known when it starts.
    //
    // MainActivity has to start us from OnPause - past that point the platform refuses a
    // foreground-service start - but OnPause is not "the app went to the background". It also
    // fires for a dialog, a share sheet, our own document picker, the unfocused half of a
    // split screen: the Activity is still on screen, the process is still held at visible
    // importance, and no notification should be shown for any of them. OnStop is the event
    // that means what we need, and it lands a beat later, so this waits for it.
    //
    // A real app switch gets there in well under a second. When nothing arrives inside the
    // grace, the app is still up and this service is redundant - it stops, and on Android 12+
    // (which sits on a foreground-service notification for ten seconds before drawing it) the
    // user never sees anything at all. The other exit - the user coming straight back - is
    // MainActivity.OnResume stopping the service outright, which cancels our token.
    private static async Task<bool> WaitForBackgroundAsync(CancellationToken token)
    {
        var giveUp = DateTimeOffset.UtcNow + BackgroundGrace;
        while (true)
        {
            if (token.IsCancellationRequested || LiveSessionCount() == 0)
            {
                return false;
            }

            if (MainActivity.IsBackgrounded)
            {
                return true;
            }

            if (DateTimeOffset.UtcNow >= giveUp)
            {
                return false;
            }

            await Task.Delay(BackgroundPollInterval, token);
        }
    }

    private static int LiveSessionCount() => MainActivity.LiveConnectionCount();

    public override void OnDestroy()
    {
        // Cancelled but not disposed: the watchdog task holds this token, and disposing the
        // source out from under it is the kind of teardown race that shows up as a crash on
        // the way out of the app for no benefit at all.
        _stopWatch?.Cancel();
        _stopWatch = null;
        StopForeground(StopForegroundFlags.Remove);
        base.OnDestroy();
    }
}
