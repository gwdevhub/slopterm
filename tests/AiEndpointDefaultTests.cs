using Slopterm.Server.Vault;
using Xunit;

namespace Slopterm.Tests;

/// <summary>
/// The AI agent is opt-in: a vault that has never been told about an endpoint has none, which
/// is what makes a terminal tab render no AI bar at all (see AgentBar). Nothing rewrites an
/// endpoint that is already stored - an install carrying the old local-Ollama default keeps
/// it, and keeps its bar, until someone clears the field themselves.
/// </summary>
[Collection("vault-dir")]
public sealed class AiEndpointDefaultTests : IDisposable
{
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

    /// <summary>Including the URL that used to be the default - it is not special-cased.</summary>
    [Fact]
    public void AStoredEndpointSurvivesARestart()
    {
        NewVault().SetAiSettings("http://127.0.0.1:11434/v1", "gemma4:12b");

        Assert.Equal("http://127.0.0.1:11434/v1", NewVault().GetSettings().AiBaseUrl);
    }

    /// <summary>Clearing the field is the only thing that turns the agent back off.</summary>
    [Fact]
    public void ClearingTheFieldStoresAnEmptyEndpoint()
    {
        var vault = NewVault();
        vault.SetAiSettings("https://ccr.example.com/v1", "some/model");

        vault.SetAiSettings(string.Empty, "some/model");

        Assert.Equal(string.Empty, vault.GetSettings().AiBaseUrl);
    }
}
