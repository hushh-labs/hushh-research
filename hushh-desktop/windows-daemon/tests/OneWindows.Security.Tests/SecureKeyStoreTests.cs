using System.Security.Cryptography;
using System.Text;
using OneWindows.Security;

namespace OneWindows.Security.Tests;

public class SecureKeyStoreTests : IDisposable
{
    private readonly string _tempDir;

    public SecureKeyStoreTests()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "one-windows-keystore-tests-" + Guid.NewGuid());
        Directory.CreateDirectory(_tempDir);
    }

    public void Dispose()
    {
        if (Directory.Exists(_tempDir))
            Directory.Delete(_tempDir, recursive: true);
    }

    private string KeyFilePath => Path.Combine(_tempDir, "keystore.bin");

    [Fact]
    public void GetOrCreateDataKey_CreatesA32ByteKeyOnFirstCall()
    {
        var store = new SecureKeyStore(KeyFilePath);
        byte[] key = store.GetOrCreateDataKey();

        Assert.Equal(32, key.Length);
        Assert.True(File.Exists(KeyFilePath));
    }

    [Fact]
    public void GetOrCreateDataKey_PersistsAcrossInstances()
    {
        var first = new SecureKeyStore(KeyFilePath);
        byte[] key1 = first.GetOrCreateDataKey();

        var second = new SecureKeyStore(KeyFilePath);
        byte[] key2 = second.GetOrCreateDataKey();

        Assert.Equal(key1, key2);
    }

    [Fact]
    public void EncryptDecrypt_RoundTripsPlaintext()
    {
        var store = new SecureKeyStore(KeyFilePath);
        byte[] plaintext = Encoding.UTF8.GetBytes("hushh one windows daemon secret payload");

        byte[] envelope = store.Encrypt(plaintext);
        byte[] decrypted = store.Decrypt(envelope);

        Assert.Equal(plaintext, decrypted);
    }

    [Fact]
    public void Encrypt_ProducesDistinctCiphertextEachCall()
    {
        var store = new SecureKeyStore(KeyFilePath);
        byte[] plaintext = Encoding.UTF8.GetBytes("same input");

        byte[] envelope1 = store.Encrypt(plaintext);
        byte[] envelope2 = store.Encrypt(plaintext);

        Assert.NotEqual(envelope1, envelope2); // random nonce each call
        Assert.Equal(plaintext, store.Decrypt(envelope1));
        Assert.Equal(plaintext, store.Decrypt(envelope2));
    }

    [Fact]
    public void Decrypt_RejectsTamperedCiphertext()
    {
        var store = new SecureKeyStore(KeyFilePath);
        byte[] envelope = store.Encrypt(Encoding.UTF8.GetBytes("integrity check"));
        envelope[^1] ^= 0xFF; // flip last ciphertext byte

        Assert.Throws<AuthenticationTagMismatchException>(() => store.Decrypt(envelope));
    }

    [Fact]
    public void Decrypt_RejectsUnknownEnvelopeVersion()
    {
        var store = new SecureKeyStore(KeyFilePath);
        byte[] envelope = store.Encrypt(Encoding.UTF8.GetBytes("versioned"));
        envelope[0] = 0xFF;

        Assert.Throws<InvalidDataException>(() => store.Decrypt(envelope));
    }
}
