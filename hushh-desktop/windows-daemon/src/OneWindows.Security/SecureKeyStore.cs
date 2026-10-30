using System.Security.Cryptography;

namespace OneWindows.Security;

/// <summary>
/// Windows-native equivalent of the Mac reference's SecureEnclaveKeyStore:
/// a random AES-256 data key is generated once, wrapped with DPAPI
/// (CurrentUser scope -- unwrappable only by this Windows user account, the
/// closest broad analogue to Secure-Enclave-bound key wrapping available
/// without a TPM/Windows Hello enrollment ceremony), and persisted to disk.
/// The unwrapped data key then does actual AES-256-GCM payload encryption,
/// so DPAPI is only ever called on a small 32-byte secret, not on arbitrary
/// caller data -- the same "wrap a key, don't wrap the data" shape Mac uses.
///
/// Envelope format for Encrypt/Decrypt: [version:1][nonce:12][tag:16][ciphertext:N].
/// </summary>
public sealed class SecureKeyStore
{
    private const byte EnvelopeVersion = 0x01;
    private const int KeySizeBytes = 32; // AES-256
    private const int NonceSizeBytes = 12; // AES-GCM standard nonce size
    private const int TagSizeBytes = 16;

    private readonly string _keyFilePath;
    private readonly object _lock = new();
    private byte[]? _cachedDataKey;

    public SecureKeyStore(string keyFilePath)
    {
        _keyFilePath = keyFilePath;
    }

    public byte[] GetOrCreateDataKey()
    {
        lock (_lock)
        {
            if (_cachedDataKey is not null)
                return _cachedDataKey;

            if (File.Exists(_keyFilePath))
            {
                byte[] protectedBytes = File.ReadAllBytes(_keyFilePath);
                _cachedDataKey = ProtectedData.Unprotect(protectedBytes, optionalEntropy: null, DataProtectionScope.CurrentUser);
                return _cachedDataKey;
            }

            byte[] dataKey = RandomNumberGenerator.GetBytes(KeySizeBytes);
            byte[] protectedKey = ProtectedData.Protect(dataKey, optionalEntropy: null, DataProtectionScope.CurrentUser);

            string? dir = Path.GetDirectoryName(_keyFilePath);
            if (!string.IsNullOrEmpty(dir))
                Directory.CreateDirectory(dir);
            File.WriteAllBytes(_keyFilePath, protectedKey);

            _cachedDataKey = dataKey;
            return _cachedDataKey;
        }
    }

    public byte[] Encrypt(byte[] plaintext)
    {
        byte[] key = GetOrCreateDataKey();
        byte[] nonce = RandomNumberGenerator.GetBytes(NonceSizeBytes);
        byte[] ciphertext = new byte[plaintext.Length];
        byte[] tag = new byte[TagSizeBytes];

        using var aesGcm = new AesGcm(key, TagSizeBytes);
        aesGcm.Encrypt(nonce, plaintext, ciphertext, tag);

        byte[] envelope = new byte[1 + NonceSizeBytes + TagSizeBytes + ciphertext.Length];
        envelope[0] = EnvelopeVersion;
        Buffer.BlockCopy(nonce, 0, envelope, 1, NonceSizeBytes);
        Buffer.BlockCopy(tag, 0, envelope, 1 + NonceSizeBytes, TagSizeBytes);
        Buffer.BlockCopy(ciphertext, 0, envelope, 1 + NonceSizeBytes + TagSizeBytes, ciphertext.Length);
        return envelope;
    }

    public byte[] Decrypt(byte[] envelope)
    {
        int headerSize = 1 + NonceSizeBytes + TagSizeBytes;
        if (envelope.Length < headerSize)
            throw new InvalidDataException("Envelope too short to contain version/nonce/tag header.");

        byte version = envelope[0];
        if (version != EnvelopeVersion)
            throw new InvalidDataException($"Unsupported envelope version {version}.");

        byte[] nonce = envelope[1..(1 + NonceSizeBytes)];
        byte[] tag = envelope[(1 + NonceSizeBytes)..headerSize];
        byte[] ciphertext = envelope[headerSize..];
        byte[] plaintext = new byte[ciphertext.Length];

        byte[] key = GetOrCreateDataKey();
        using var aesGcm = new AesGcm(key, TagSizeBytes);
        aesGcm.Decrypt(nonce, ciphertext, tag, plaintext);
        return plaintext;
    }
}
