// Several sync tests deliberately assert on controlled wall-clock orderings, so the suite
// runs serially even though each fixture is now self-contained.
[assembly: Xunit.CollectionBehavior(DisableTestParallelization = true)]
