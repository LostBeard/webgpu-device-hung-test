#:package Microsoft.Playwright@1.63.0
#:property PublishAot=false
// Runs the test page's buttons in a fresh installed Chrome (own temp profile) and prints each result and the report.
// dotnet run drive.cs -- <page url> <control|test|fix>[,...] [high-performance|low-power]
// Set CHROME_EXE to use another chrome.exe (for example a Chrome for Testing unzip) instead of the installed Chrome.
using Microsoft.Playwright;

string url = args[0];
string[] tests = args[1].Split(',');
string pref = args.Length > 2 ? args[2] : "high-performance";
string profile = Path.Combine(Path.GetTempPath(), "wdh_" + Guid.NewGuid().ToString("N")[..8]);
string? exe = Environment.GetEnvironmentVariable("CHROME_EXE");

using var pw = await Playwright.CreateAsync();
try
{
foreach (var t in tests)
{
    // a fresh browser per test: after a device loss the browser may refuse WebGPU for the rest of the session
    await using var ctx = await pw.Chromium.LaunchPersistentContextAsync(profile, new BrowserTypeLaunchPersistentContextOptions
    {
        Headless = false,
        Channel = exe is null ? "chrome" : null,
        ExecutablePath = exe,
        Args = new[] { "--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--disable-gpu-shader-disk-cache" },
    });
    var page = ctx.Pages.Count > 0 ? ctx.Pages[0] : await ctx.NewPageAsync();
    // The page can stop answering for 30+ s while Chrome compiles a large shader on a slow CPU (measured ~32 s on an
    // i5-3330), so every page call allows 180 s.
    page.SetDefaultTimeout(180000);
    await page.GotoAsync(url);
    await page.WaitForSelectorAsync($"button[data-t={t}]");
    Console.WriteLine("GPU: " + (await page.InnerTextAsync("#gpu")).Replace("\n", " | "));
    await page.CheckAsync($"input[name=pp][value={pref}]");
    await page.ClickAsync($"button[data-t={t}]");
    var sw = System.Diagnostics.Stopwatch.StartNew();
    string st = "";
    while (sw.Elapsed.TotalSeconds < 900)
    {
        await Task.Delay(1000);
        st = await page.InnerTextAsync($"#st-{t}");
        if (await page.IsEnabledAsync($"button[data-t={t}]")) break;
    }
    Console.WriteLine($"RESULT {t} ({pref}): {st}  [{sw.Elapsed.TotalSeconds:F0} s]");
    if (t == tests[^1]) Console.WriteLine("REPORT:\n" + await page.InputValueAsync("#report"));
    await ctx.CloseAsync();
}
}
finally
{
    try { Directory.Delete(profile, true); } catch { }
}
