using System.Buffers.Binary;
using Slopterm.Server;
using Xunit;

namespace Slopterm.Tests;

public sealed class UpdateServiceTests : IDisposable
{
    private static readonly byte[] BundleHeaderSignature =
    [
        0x8b, 0x12, 0x02, 0xb9, 0x6a, 0x61, 0x20, 0x38,
        0x72, 0x7b, 0x93, 0x02, 0x14, 0xd7, 0xa0, 0x32,
        0x13, 0xf5, 0xb9, 0xe6, 0xef, 0xae, 0x33, 0x18,
        0xee, 0x3b, 0x2d, 0xce, 0x24, 0xb3, 0x6a, 0xae
    ];

    private readonly string _tempDirectory = Path.Combine(Path.GetTempPath(), $"slopterm-update-tests-{Guid.NewGuid():N}");

    [Fact]
    public void IsSingleFileBundle_RejectsOrdinaryAppHostPlaceholder()
    {
        var path = WriteAppHost(headerOffset: 0);

        Assert.False(UpdateService.IsSingleFileBundle(path));
    }

    [Fact]
    public void IsSingleFileBundle_AcceptsPopulatedBundleHeaderAcrossBufferBoundary()
    {
        var path = WriteAppHost(headerOffset: 123456, signatureOffset: (64 * 1024) - 10);

        Assert.True(UpdateService.IsSingleFileBundle(path));
    }

    private string WriteAppHost(long headerOffset, int signatureOffset = 128)
    {
        Directory.CreateDirectory(_tempDirectory);
        var bytes = new byte[signatureOffset + BundleHeaderSignature.Length + 16];
        BinaryPrimitives.WriteInt64LittleEndian(bytes.AsSpan(signatureOffset - sizeof(long)), headerOffset);
        BundleHeaderSignature.CopyTo(bytes, signatureOffset);

        var path = Path.Combine(_tempDirectory, Guid.NewGuid().ToString("N"));
        File.WriteAllBytes(path, bytes);
        return path;
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDirectory))
        {
            Directory.Delete(_tempDirectory, recursive: true);
        }
    }
}
