using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("语忆AI")]
[assembly: AssemblyProduct("语忆AI")]
[assembly: AssemblyDescription("语忆AI独立桌面窗口")]
[assembly: AssemblyVersion("1.1.0.0")]

internal static class DesktopLauncher
{
    internal static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;
    internal static readonly string Runtime = Path.Combine(Root, "runtime", "webview2");
    internal static bool NoDialog;
    internal static int ExitCode;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern bool SetDllDirectory(string path);
    [DllImport("user32.dll")] private static extern bool SetProcessDPIAware();

    [STAThread]
    private static int Main(string[] args)
    {
        NoDialog = Array.IndexOf(args, "--no-dialog") >= 0;
        try
        {
            string requested = null;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--no-dialog") continue;
                if (args[i] == "--url" && i + 1 < args.Length) requested = ValidateUrl(args[++i]);
                else throw new ArgumentException("无法识别的启动参数。");
            }
            SetDllDirectory(Runtime);
            AppDomain.CurrentDomain.AssemblyResolve += delegate(object sender, ResolveEventArgs e)
            {
                string name = new AssemblyName(e.Name).Name;
                if (name != "Microsoft.Web.WebView2.Core" && name != "Microsoft.Web.WebView2.WinForms") return null;
                return Assembly.LoadFrom(Path.Combine(Runtime, name + ".dll"));
            };
            SetProcessDPIAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            RunWindow(requested);
            return ExitCode;
        }
        catch (Exception error) { Fail(error); return 1; }
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static void RunWindow(string requested) { Application.Run(new DesktopWindow(requested)); }

    internal static string ValidateUrl(string text)
    {
        Uri url;
        if (!Uri.TryCreate(text, UriKind.Absolute, out url) || url.Scheme != "http" ||
            url.Host != "127.0.0.1" || url.Port < 7788 || url.Port > 7797 ||
            url.UserInfo.Length != 0 || url.AbsolutePath != "/" || url.Query.Length != 0)
            throw new InvalidDataException("本地界面地址无效，请重新打开软件。");
        return url.AbsoluteUri;
    }

    internal static string StartConsole()
    {
        string script = Path.Combine(Root, "launcher.py");
        if (!File.Exists(script)) throw new FileNotFoundException("请使用完整程序目录或桌面快捷方式打开软件。");
        string python = Path.Combine(Root, "runtime", "python", "python.exe");
        if (!File.Exists(python))
        {
            using (Stream stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("python-path"))
                if (stream != null) using (StreamReader reader = new StreamReader(stream)) python = reader.ReadToEnd().Trim();
        }
        if (!File.Exists(python)) throw new FileNotFoundException("程序运行环境不完整，请重新安装完整版本。");
        var info = new ProcessStartInfo(python, "-X utf8 \"" + script + "\" --console-url") {
            WorkingDirectory = Root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8 };
        using (Process process = Process.Start(info))
        {
            Task<string> output = process.StandardOutput.ReadToEndAsync();
            Task<string> errors = process.StandardError.ReadToEndAsync();
            if (!process.WaitForExit(35000))
            {
                process.Kill();
                throw new TimeoutException("本地服务启动超时，请稍后重新打开软件。");
            }
            if (process.ExitCode != 0) throw new InvalidOperationException("本地服务未能启动。" + errors.Result.Trim());
            return ValidateUrl(output.Result.Trim());
        }
    }

    internal static void Fail(Exception error)
    {
        ExitCode = 1;
        try {
            Directory.CreateDirectory(Path.Combine(Root, "data"));
            File.AppendAllText(Path.Combine(Root, "data", "desktop.log"), DateTime.UtcNow.ToString("O") + " " + error + Environment.NewLine);
        } catch { }
        if (!NoDialog) MessageBox.Show("软件未能打开：" + error.Message, "语忆AI", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }
}

internal sealed class DesktopWindow : Form
{
    private readonly WebView2 view;
    private readonly Label status;
    private readonly string requested;
    private string origin;
    private bool closing;

    internal DesktopWindow(string requestedUrl)
    {
        requested = requestedUrl;
        Text = "语忆AI";
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(1280, 840);
        MinimumSize = new Size(960, 680);
        BackColor = Color.FromArgb(20, 22, 26);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        status = new Label { Dock = DockStyle.Fill, ForeColor = Color.FromArgb(230, 232, 236),
            TextAlign = ContentAlignment.MiddleCenter, Text = "正在打开语忆AI…", Font = new Font("Microsoft YaHei UI", 11) };
        view = new WebView2 { Dock = DockStyle.Fill, Visible = false, DefaultBackgroundColor = BackColor };
        Controls.Add(view); Controls.Add(status);
        Shown += async delegate { await OpenAsync(); };
        FormClosing += delegate { closing = true; };
        FormClosed += delegate { view.Dispose(); };
    }

    private async Task OpenAsync()
    {
        try
        {
            string url = requested ?? await Task.Run(() => DesktopLauncher.StartConsole());
            if (closing) return;
            origin = new Uri(url).GetLeftPart(UriPartial.Authority);
            bool runtimeMissing = false;
            try { CoreWebView2Environment.GetAvailableBrowserVersionString(); }
            catch (WebView2RuntimeNotFoundException) { runtimeMissing = true; }
            if (runtimeMissing)
            {
                status.Text = "正在准备界面运行组件，首次使用需要联网，请稍候…";
                await Task.Run(() => InstallRuntime());
                if (closing) return;
                CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DesktopLauncher.Root, "data", "webview2-profile"));
            if (closing) return;
            await view.EnsureCoreWebView2Async(environment);
            if (closing) return;
            view.CoreWebView2.Settings.AreHostObjectsAllowed = false;
            view.CoreWebView2.Settings.IsWebMessageEnabled = false;
            view.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                Uri target;
                if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out target) || target.GetLeftPart(UriPartial.Authority) != origin) e.Cancel = true;
            };
            view.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) {
                e.Handled = true;
                Uri target;
                if (e.IsUserInitiated && Uri.TryCreate(e.Uri, UriKind.Absolute, out target) && target.Scheme == "https")
                    Process.Start(new ProcessStartInfo(target.AbsoluteUri) { UseShellExecute = true });
            };
            view.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e) {
                if (closing) return;
                if (!e.IsSuccess) { status.Text = "界面加载失败，请关闭窗口后重新打开。"; status.Visible = true; return; }
                status.Visible = false; view.Visible = true; view.BringToFront();
            };
            view.CoreWebView2.ProcessFailed += delegate {
                if (!closing) { status.Text = "界面运行组件已退出，请关闭窗口后重新打开。"; status.Visible = true; status.BringToFront(); }
            };
            view.CoreWebView2.Navigate(url);
        }
        catch (Exception error) { if (!closing) { DesktopLauncher.Fail(error); Close(); } }
    }

    private static void InstallRuntime()
    {
        string bootstrapper = Path.Combine(DesktopLauncher.Runtime, "MicrosoftEdgeWebview2Setup.exe");
        if (!File.Exists(bootstrapper)) throw new FileNotFoundException("缺少微软界面运行组件安装程序，请重新安装完整版本。");
        var info = new ProcessStartInfo(bootstrapper, "/silent /install") { UseShellExecute = false, CreateNoWindow = true };
        using (Process process = Process.Start(info)) {
            // The shared Microsoft installer owns its download/install lifecycle.
            if (!process.WaitForExit(180000)) throw new TimeoutException("界面运行组件仍在安装，请稍后重新打开软件。");
            if (process.ExitCode != 0) throw new InvalidOperationException("微软界面运行组件安装未完成，请检查网络后重试。");
        }
    }
}
