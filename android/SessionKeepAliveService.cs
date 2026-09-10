using Android.App;
using Android.Content;
using Android.Content.PM;
using Android.OS;
using Slopterm.Server;

namespace Slopterm.Mobile;

// Keeps the process out of the cached/frozen state for a few minutes after the user switches
// away so SSH connections survive; a provisional foreground service that stops itself (see WaitForBackgroundAsync).
[Service(
    Name = "com.gwdevhub.slopterm.SessionKeepAliveService",
    Exported = false,
    ForegroundServiceType = ForegroundService.TypeDataSync)]
public sealed class SessionKeepAliveService : Service
{
    private const int NotificationId = 2;

    // Two channels because a channel's badge/importance are fixed at creation; the quiet default
    // takes importance to Min, the closest to "no notification" an app can get.
    private const string QuietChannelId = "slopterm_sessions_quiet";
    private const string BadgeChannelId = "slopterm_sessions_badge";

    // Superseded by the pair above; deleted so upgrading installs don't leave a dead entry.
    private const string LegacyChannelId = "slopterm_sessions_channel";

    // How long connections survive the user switching apps; bounded so a forgotten app can't
    // hold a wake-worthy service all day.
    private static readonly TimeSpan MaxLifetime = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(20);

    // How long to wait for OnStop after the OnPause that started us; under the 10s Android 12+
    // defers a notification by, and over a real app switch's sub-second gap.
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

        // Off by default: the notification is a foreground-service requirement, not something
        // the user asked for (see AppSettings.SessionNotificationBadge).
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

        // Statements rather than a fluent chain: each call returns Notification.Builder? in the
        // bindings, so chaining is a string of dereferences the compiler can't prove safe.
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

    // Stops when the app returns, nothing is left to keep alive, or the hard cap is reached;
    // never long enough to meet Android 15's six-hours-per-day dataSync budget, so OnTimeout is unused.
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

    // True once the app is actually backgrounded with something to keep; false if it isn't
    // going anywhere. OnPause can't tell (dialogs/pickers fire it too), so this waits for OnStop.
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
        // Cancelled but not disposed: the watchdog task holds this token.
        _stopWatch?.Cancel();
        _stopWatch = null;
        StopForeground(StopForegroundFlags.Remove);
        base.OnDestroy();
    }
}
