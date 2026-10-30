namespace OneWindows.Daemon;

/// <summary>
/// Locates APP_SIGNING_KEY so tokens issued by the existing Electron/Python
/// backend validate here too -- this daemon is deliberately a separate
/// process from that backend (see "option a" in the architecture decision),
/// but it must trust the same signing key or no token would ever cross
/// between them.
///
/// Resolution order:
///   1. APP_SIGNING_KEY environment variable (explicit override, e.g. for
///      local dev/testing without touching the real Electron-managed file).
///   2. HUSHH_BACKEND_ENV_PATH environment variable, if set, pointing
///      directly at a backend.env file.
///   3. %APPDATA%\hushh-desktop\backend.env -- confirmed to be the real
///      path Electron's launcher writes to in dev mode (package.json's
///      "name" field, not "productName", is what Electron's app.getPath
///      uses when unpackaged).
///   4. %APPDATA%\Hushh Desktop\backend.env -- fallback in case a packaged
///      build resolves userData from "productName" instead; unverified
///      until a real packaged build ships.
///   5. C:\Users\*\AppData\Roaming\(hushh-desktop|Hushh Desktop)\backend.env
///      -- last resort for when this process is running as a system
///      account (e.g. a Windows Service under LocalSystem) whose own
///      %APPDATA% is system32\config\systemprofile, not the desktop user's
///      profile. This is a workaround, not the real fix: a LocalSystem
///      service is architecturally the wrong model for a per-user secret
///      like this one (it's the Windows analogue of a macOS LaunchDaemon,
///      when what's actually needed is the LaunchAgent equivalent -- a
///      per-user-session service). On a genuinely multi-user machine this
///      scan is ambiguous by construction; it exists to unblock local dev
///      on a single-user box, not as a real multi-tenant answer.
/// </summary>
public static class SigningKeyLocator
{
    private const string SigningKeyEnvVar = "APP_SIGNING_KEY";
    private const string EnvPathOverrideVar = "HUSHH_BACKEND_ENV_PATH";
    private static readonly string[] AppFolderNames = { "hushh-desktop", "Hushh Desktop" };

    public static string Resolve()
    {
        string? directOverride = Environment.GetEnvironmentVariable(SigningKeyEnvVar);
        if (!string.IsNullOrWhiteSpace(directOverride))
            return directOverride;

        var candidates = new List<string>();

        string? pathOverride = Environment.GetEnvironmentVariable(EnvPathOverrideVar);
        if (!string.IsNullOrWhiteSpace(pathOverride))
            candidates.Add(pathOverride);

        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        foreach (string folderName in AppFolderNames)
            candidates.Add(Path.Combine(appData, folderName, "backend.env"));

        foreach (string path in candidates)
        {
            if (!File.Exists(path)) continue;

            string? key = ReadEnvValue(path, SigningKeyEnvVar);
            if (!string.IsNullOrWhiteSpace(key))
                return key;
        }

        foreach (string path in ScanOtherUserProfiles())
        {
            string? key = ReadEnvValue(path, SigningKeyEnvVar);
            if (!string.IsNullOrWhiteSpace(key))
                return key;
        }

        throw new InvalidOperationException(
            $"Could not resolve {SigningKeyEnvVar}. Checked env var, then: " +
            string.Join(", ", candidates) +
            $", then a scan of C:\\Users\\*\\AppData\\Roaming for the same file. " +
            $"Set {SigningKeyEnvVar} directly or {EnvPathOverrideVar} to point at a backend.env file.");
    }

    private static IEnumerable<string> ScanOtherUserProfiles()
    {
        string usersRoot = Path.Combine(
            Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.Windows)) ?? "C:\\",
            "Users");

        string[] profileDirs;
        try
        {
            profileDirs = Directory.Exists(usersRoot) ? Directory.GetDirectories(usersRoot) : Array.Empty<string>();
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException)
        {
            yield break;
        }

        foreach (string profileDir in profileDirs)
        {
            foreach (string folderName in AppFolderNames)
            {
                string candidate = Path.Combine(profileDir, "AppData", "Roaming", folderName, "backend.env");
                bool exists;
                try { exists = File.Exists(candidate); }
                catch (UnauthorizedAccessException) { continue; }

                if (exists) yield return candidate;
            }
        }
    }

    private static string? ReadEnvValue(string path, string key)
    {
        string prefix = key + "=";
        foreach (string line in File.ReadLines(path))
        {
            string trimmed = line.Trim();
            if (trimmed.StartsWith(prefix, StringComparison.Ordinal))
                return trimmed[prefix.Length..].Trim();
        }
        return null;
    }
}
