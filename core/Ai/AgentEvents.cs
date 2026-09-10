using System.Text.Json;

namespace Slopterm.Server.Ai;

/// <summary>
/// The single shared serializer for the agent WebSocket channel - every SendAsync/Deserialize on
/// that channel must route through it so the wire stays camelCase and matches the pinned contract.
/// </summary>
public static class AgentJson
{
    public static readonly JsonSerializerOptions Web = new(JsonSerializerDefaults.Web);
}

/// <summary>Inbound client frame: <c>send</c>/<c>stop</c>/<c>clear</c>/<c>list_chats</c>/<c>open_chat</c>/<c>new_chat</c>/<c>delete_chat</c> (chat ops carry <c>Id</c>).</summary>
public sealed class AgentClientMessage
{
    public string? Type { get; set; }
    public string? Mode { get; set; }
    public string? Model { get; set; }
    public string? Text { get; set; }
    public string? Id { get; set; }

    /// <summary>
    /// On a <c>send</c>: start a fresh conversation first. Done as part of the send (not a separate
    /// <c>new_chat</c> frame) so no empty <c>history</c> frame wipes the optimistically-rendered message.
    /// </summary>
    public bool NewChat { get; set; }
}

/// <summary>One entry in the per-host saved-conversations list (the <c>chats</c> frame).</summary>
public sealed class ChatSummary
{
    public required string Id { get; set; }
    public required string Title { get; set; }
    public required DateTimeOffset UpdatedAt { get; set; }
    public required int MessageCount { get; set; }
    public required bool Active { get; set; }
}

/// <summary>One entry in the replayed display transcript (the <c>history</c> frame).</summary>
public sealed class ChatMessage
{
    public required string Id { get; set; }
    public required string Role { get; set; }
    public string Text { get; set; } = "";
    public required string Mode { get; set; }
    public List<ChatActivity> Activities { get; set; } = [];
}

public sealed class ChatActivity
{
    public required string Tool { get; set; }
    public required string Summary { get; set; }
}
