// Every test that constructs a VaultService flips SLOPTERM_VAULT_DIR, which is process-wide -
// so they must not run in parallel with each other, or two tests race over which vault
// directory the next `new VaultService()` picks up.
[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]
