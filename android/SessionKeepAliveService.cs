using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.OS;
using Slopterm.Server;

namespace Slopterm.Mobile;

// Keeps the app's process running normally for a few minutes after the user switches away,
// so the SSH connections it holds stay up.
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
    // Not 1: MainActivity's app-badge notification already owns that id, and reusing it would
    // replace the badge with this one.
    private const int NotificationId = 2;
    private const string ChannelId = "slopterm_sessions_channel";

    // The whole point of the exercise: how long connections survive the user switching apps.
    // Bounded so a forgotten app can't hold a wake-worthy service (and a notification) all
    // day; generous enough to cover looking something up elsewhere and coming back.
    private static readonly TimeSpan MaxLifetime = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(20);

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

        Notification.Builder builder;
        if (OperatingSystem.IsAndroidVersionAtLeast(26))
        {
            // Low importance: no sound, no heads-up. This notification is a requirement of
            // running in the foreground, not something the user needs to look at.
            var manager = (NotificationManager?)GetSystemService(NotificationService);
            manager?.CreateNotificationChannel(
                new NotificationChannel(ChannelId, "Active sessions", NotificationImportance.Low)
                {
                    Description = "Shown while slopterm is holding connections open in the background",
                });
            builder = new Notification.Builder(this, ChannelId);
        }
        else
        {
#pragma warning disable CA1422 // the channel-less builder is the correct one below API 26
            builder = new Notification.Builder(this).SetPriority((int)NotificationPriority.Low);
#pragma warning restore CA1422
        }

        var notification = builder
            .SetSmallIcon(Resource.Drawable.ic_launcher)
            .SetContentTitle("slopterm")
            .SetContentText(text)
            .SetContentIntent(contentIntent)
            .SetOngoing(true)
            .SetOnlyAlertOnce(true)
            .Build();

        if (OperatingSystem.IsAndroidVersionAtLeast(29))
        {
            StartForeground(NotificationId, notification, ForegroundService.TypeDataSync);
        }
        else
        {
            StartForeground(NotificationId, notification);
        }
    }

    // Stops as soon as there's nothing left to keep alive, and in any case at the hard cap.
    // The count can reach zero while backgrounded - a shell exits on its own, a forward
    // fails - and the notification goes away as soon as it does rather than sitting out the
    // rest of the window.
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
                while (!token.IsCancellationRequested)
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
            catch (OperationCanceledException)
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
