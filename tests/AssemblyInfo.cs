// The sync tests spin up two VaultService instances that write to real temp directories and
// converge through a shared in-memory remote. Each fixture is self-contained now (its vault
// directories are passed in, not set through the environment), but the suite still runs
// serially: several tests deliberately assert on wall-clock-free orderings, and parallel
// execution buys nothing here beyond making a failure harder to read.
[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]
