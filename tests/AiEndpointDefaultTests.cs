using Slopterm.Server.Vault;
using Xunit;

namespace Slopterm.Tests;

/// <summary>
/// The one-time pass that clears the AI endpoint's old local-Ollama default, so an install
/// upgraded into the opt-in agent doesn't keep an AI bar pointed at a port nothing answers on
/// (see VaultService.ClearLegacyAiEndpointOnce).
/// </summary>
[Collection("vault-dir")]
public sealed class AiEndpointDefaultTests : IDisposable
{
    private const string LegacyDefault = "http://127.0.0.1:11434/v1";

    private readonly string _dir = Path.Combine(
        Path.GetTempPath(), "slopterm-ai-endpoint-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private VaultService NewVault()
    {
        var vault = new VaultService(vaultDirectory: _dir);
        vault.EnsureUnlockedIfPasswordNotRequired();
        return vault;
    }

    [Fact]
    public void AFreshInstallHasNoEndpointAtAll()
    {
        Assert.Equal(string.Empty, NewVault().GetSettings().AiBaseUrl);
    }

    [Fact]
    public void TheOldOllamaDefaultIsClearedOnce()
    {
        var vault = NewVault();
        vault.SetAiSettings(LegacyDefault, "gemma4:12b");

        vault.ClearLegacyAiEndpointOnce();

        Assert.Equal(string.Empty, vault.GetSettings().AiBaseUrl);
    }

    /// <summary>
    /// The point of the marker: someone who genuinely runs Ollama can type that same URL back
    /// in and keep it. A pass that ran on every start would take it away again.
    /// </summary>
    [Fact]
    public void ReEnteringThatUrlAfterwardsSurvives()
    {
        var vault = NewVault();
        vault.SetAiSettings(LegacyDefault, "gemma4:12b");
        vault.ClearLegacyAiEndpointOnce();

        vault.SetAiSettings(LegacyDefault, "gemma4:12b");
        vault.ClearLegacyAiEndpointOnce();

        Assert.Equal(LegacyDefault, vault.GetSettings().AiBaseUrl);
    }

    /// <summary>Only that exact URL is touched - a real, chosen endpoint is not a default.</summary>
    [Fact]
    public void AnEndpointTheUserChoseIsLeftAlone()
    {
        var vault = NewVault();
        vault.SetAiSettings("https://ccr.example.com/v1", "some/model");

        vault.ClearLegacyAiEndpointOnce();

        Assert.Equal("https://ccr.example.com/v1", vault.GetSettings().AiBaseUrl);
    }

    /// <summary>The marker is on disk, so a restart doesn't get a second go at it.</summary>
    [Fact]
    public void TheMarkerSurvivesARestart()
    {
        var first = NewVault();
        first.SetAiSettings(LegacyDefault, "gemma4:12b");
        first.ClearLegacyAiEndpointOnce();
        first.SetAiSettings(LegacyDefault, "gemma4:12b");

        var afterRestart = NewVault();
        afterRestart.ClearLegacyAiEndpointOnce();

        Assert.Equal(LegacyDefault, afterRestart.GetSettings().AiBaseUrl);
    }
}
