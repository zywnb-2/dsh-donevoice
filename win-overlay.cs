using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using System.Threading;

// DoneVoice 原生覆盖层：全屏彩色边框光效 + 顶部提醒卡片。
//
// 为什么不用 WPF：worker 主循环是阻塞读 stdin 的（没有消息泵），WPF 窗口渲染不出来。
// 改用 Win32 分层窗口（WS_EX_LAYERED|WS_EX_TOPMOST|WS_EX_NOACTIVATE|WS_EX_TOOLWINDOW）
// + 每帧自己合成 32bpp 预乘 ARGB 位图 + UpdateLayeredWindow：
//   · 不需要 WPF 那套消息泵（UpdateLayeredWindow 直接把内容推给合成器）；
//   · WS_EX_NOACTIVATE + SW_SHOWNOACTIVATE ⇒ 绝不抢焦点。
//
// ## 点击（2026-10-03 补）
//
// 用户定稿的第一条规则是**「点击提醒卡片就回到 DSH」**。原先的版本给窗口加了
// `WS_EX_TRANSPARENT`（鼠标全穿透），于是这张卡片**物理上点不动** ——
// 而"你在页面上"那条路径按设计又不弹系统通知，屏幕上一个能点的东西都没有。
//
// 现在的做法：
//   · **去掉** `WS_EX_TRANSPARENT`，改成自己 `WM_NCHITTEST`：
//     卡片矩形内返回 `HTCLIENT`（可点），矩形外返回 `HTTRANSPARENT`（照旧穿透到下面的窗口）。
//   · 用 `RegisterClassEx` 注册**自己的窗口类**（而不是 subclass 一个 STATIC），
//     这样 WndProc 是原生的，不用 `SetWindowLongPtr`，也就没有 32/64 位之分。
//   · 渲染循环里用 `PeekMessage` 抽消息（非阻塞，不影响 30fps 的节奏）。
//   · 点击后：先写点击标记文件（与 activate.ps1 同一条竞态约束：**必须先落标记再抢焦点**），
//     再把 DSH 窗口拿回前台，然后让渲染循环立刻收工（卡片消失）。
//
// ⚠️ 为什么这里的 `SetForegroundWindow` 能成：Windows 的前台锁对"**刚刚收到用户输入的进程**"
//    是放开的，而这次点击正好落在我们的窗口上 —— 这与 activate.ps1 靠"被点击拉起"拿到的
//    是同一个资格。仍然保留 TOPMOST / 抖 Alt 两级兜底，与 activate.ps1 同款。
public static class DvOverlay
{
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("gdi32.dll")] static extern int GetDeviceCaps(IntPtr hdc, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(int exStyle, string cls, string name, int style, int x, int y, int w, int h, IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr srcDc, ref POINT dst, ref SIZE size, IntPtr memDc, ref POINT src, int colorKey, ref BLENDFUNCTION blend, int flags);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);

    // ── 消息与点击 ───────────────────────────────────────────────────────────
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassEx(ref WNDCLASSEX lpwcx);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadCursor(IntPtr inst, IntPtr name);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X; public int Y; }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int CX; public int CY; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)]
    struct BLENDFUNCTION { public byte BlendOp; public byte BlendFlags; public byte SourceConstantAlpha; public byte AlphaFormat; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam;
        public uint time; public int ptX; public int ptY;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASSEX
    {
        public int cbSize; public int style; public IntPtr lpfnWndProc;
        public int cbClsExtra; public int cbWndExtra; public IntPtr hInstance;
        public IntPtr hIcon; public IntPtr hCursor; public IntPtr hbrBackground;
        public string lpszMenuName; public string lpszClassName; public IntPtr hIconSm;
    }
    delegate IntPtr WndProcDelegate(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    const int WS_POPUP = unchecked((int)0x80000000);
    const int WS_EX_LAYERED = 0x00080000;
    const int WS_EX_TOPMOST = 0x00000008;
    const int WS_EX_NOACTIVATE = 0x08000000;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int SW_SHOWNOACTIVATE = 4;
    const int SW_RESTORE = 9;
    const int ULW_ALPHA = 0x00000002;
    const byte AC_SRC_OVER = 0x00;
    const byte AC_SRC_ALPHA = 0x01;
    const uint WM_NCHITTEST = 0x0084;
    const uint WM_LBUTTONUP = 0x0202;
    const uint PM_REMOVE = 0x0001;
    const int HTTRANSPARENT = -1;
    const int HTCLIENT = 1;
    const int IDC_HAND = 32649;
    const int ERROR_CLASS_ALREADY_EXISTS = 1410;
    const string OVERLAY_CLASS = "DoneVoiceOverlayWnd";

    // ── 覆盖层的当前状态（一个覆盖层同时只存在一个实例） ──────────────────────
    static readonly object gate = new object();
    static int generation = 0;
    static Thread thread = null;
    static volatile bool lastOk = false;
    static volatile int frames = 0;
    static volatile int lastFrameMs = 0;
    static long shownAtTicks = 0;

    // ── 点击相关状态 ─────────────────────────────────────────────────────────
    // ★ `wndProcKeepAlive` 必须由**静态字段**持有：只把委托交给 RegisterClassEx 的话，
    //    GC 会在任意时刻回收它，窗口过程随即变成野指针 —— 表现为"点几次之后突然崩"，
    //    而且完全不报错。这是 Win32 互操作最经典的坑之一。
    static readonly WndProcDelegate wndProcKeepAlive = OverlayWndProc;
    static IntPtr dshWindow = IntPtr.Zero;
    static string clickMarkerPath = null;
    static volatile bool clickRequested = false;
    static volatile bool classRegistered = false;
    /// <summary>当前卡片的不透明度，WndProc 据此决定"这一刻要不要接收点击"。</summary>
    static double hitAlpha = 0.0;
    /// <summary>当前卡片的命中矩形（**屏幕坐标**，物理像素）。</summary>
    static RectangleF hitRect = RectangleF.Empty;

    public static string ScreenInfo()
    {
        try { SetProcessDPIAware(); } catch { }
        int x = GetSystemMetrics(76), y = GetSystemMetrics(77), w = GetSystemMetrics(78), h = GetSystemMetrics(79);
        double dpi = 96.0;
        try
        {
            IntPtr dc = GetDC(IntPtr.Zero);
            if (dc != IntPtr.Zero)
            {
                int d = GetDeviceCaps(dc, 88);
                if (d > 0) dpi = d;
                ReleaseDC(IntPtr.Zero, dc);
            }
        }
        catch { }
        return "{\"x\":" + x + ",\"y\":" + y + ",\"w\":" + w + ",\"h\":" + h + ",\"dpi\":" + dpi + "}";
    }

    public static string Status()
    {
        bool alive;
        lock (gate) { alive = thread != null && thread.IsAlive; }
        int age = 0;
        long t = Interlocked.Read(ref shownAtTicks);
        if (t != 0) age = (int)((DateTime.UtcNow.Ticks - t) / TimeSpan.TicksPerMillisecond);
        return "{\"alive\":" + (alive ? "true" : "false") + ",\"ok\":" + (lastOk ? "true" : "false")
            + ",\"frames\":" + frames + ",\"lastFrameMs\":" + lastFrameMs + ",\"ageMs\":" + age + "}";
    }

    // ── 点击：命中测试 / 窗口过程 / 回到 DSH ──────────────────────────────────

    /// <summary>
    /// 注册自己的窗口类。用 RegisterClassEx 而不是 subclass 一个 STATIC：
    /// WndProc 从创建那一刻就是我们的，不需要 SetWindowLongPtr，也就没有 32/64 位之分。
    /// </summary>
    /// <returns>可用返回 true。</returns>
    static bool EnsureWindowClass()
    {
        if (classRegistered) return true;
        try
        {
            var wc = new WNDCLASSEX();
            wc.cbSize = Marshal.SizeOf(typeof(WNDCLASSEX));
            wc.style = 0;
            wc.lpfnWndProc = Marshal.GetFunctionPointerForDelegate(wndProcKeepAlive);
            wc.hInstance = GetModuleHandle(null);
            wc.hCursor = LoadCursor(IntPtr.Zero, (IntPtr)IDC_HAND);
            wc.lpszClassName = OVERLAY_CLASS;
            ushort atom = RegisterClassEx(ref wc);
            if (atom == 0)
            {
                // 类已经注册过是**正常**情况：同一个进程里第二次弹提醒就会撞上。
                if (Marshal.GetLastWin32Error() != ERROR_CLASS_ALREADY_EXISTS) return false;
            }
            classRegistered = true;
            return true;
        }
        catch { return false; }
    }

    /// <summary>
    /// 窗口过程：只处理两件事 —— 命中测试（决定哪块区域可点）与左键抬起（回到 DSH）。
    /// 其余一律交回 DefWindowProc。
    /// </summary>
    static IntPtr OverlayWndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            if (msg == WM_NCHITTEST)
            {
                // 卡片还没出现（或已经淡出）⇒ 整块屏幕照旧穿透，绝不挡住用户操作。
                if (hitAlpha <= 0.35) return (IntPtr)HTTRANSPARENT;
                long lp = lParam.ToInt64();
                // WM_NCHITTEST 的 lParam 是**屏幕坐标**（低 16 位 x、高 16 位 y，有符号）。
                int sx = (short)(lp & 0xFFFF);
                int sy = (short)((lp >> 16) & 0xFFFF);
                RectangleF r = hitRect;
                bool inside = sx >= r.Left && sx <= r.Right && sy >= r.Top && sy <= r.Bottom;
                // 卡片内 ⇒ HTCLIENT（可点）；卡片外 ⇒ HTTRANSPARENT（继续往下找窗口，保持穿透）。
                return (IntPtr)(inside ? HTCLIENT : HTTRANSPARENT);
            }
            if (msg == WM_LBUTTONUP)
            {
                HandleCardClick();
                return IntPtr.Zero;
            }
        }
        catch { }
        return DefWindowProc(hWnd, msg, wParam, lParam);
    }

    /// <summary>点击卡片：落标记 → 把 DSH 拿回前台 → 让渲染循环收工。</summary>
    static void HandleCardClick()
    {
        // ① **先落点击标记**。顺序是关键（真机踩过的竞态，activate.ps1 里有同一段说明）：
        //    页面是在"拿到焦点"那一瞬去读标记的，先抢焦点就会读到空。
        try
        {
            if (!string.IsNullOrEmpty(clickMarkerPath))
                System.IO.File.WriteAllText(clickMarkerPath, DateTime.UtcNow.ToString("o"));
        }
        catch { }

        // ② 把 DSH 窗口拿回前台。这次点击落在我们的窗口上 ⇒ 本进程"刚收到用户输入"
        //    ⇒ Windows 的前台锁对本进程放开（与 activate.ps1 的资格来源相同）。
        try
        {
            IntPtr t = dshWindow;
            if (t != IntPtr.Zero)
            {
                if (IsIconic(t)) ShowWindow(t, SW_RESTORE);
                if (!SetForegroundWindow(t))
                {
                    // 兜底一：临时置顶再 focus（activate.ps1 同款，比抖 Alt 稳）。
                    RECT rect;
                    if (GetWindowRect(t, out rect))
                    {
                        int w = rect.Right - rect.Left;
                        int h = rect.Bottom - rect.Top;
                        SetWindowPos(t, (IntPtr)(-1), 0, 0, 0, 0, 0x0003);   // HWND_TOPMOST + NOMOVE|NOSIZE
                        SetForegroundWindow(t);
                        Thread.Sleep(120);
                        SetWindowPos(t, (IntPtr)(-2), rect.Left, rect.Top, w, h, 0x0000); // HWND_NOTOPMOST
                        SetForegroundWindow(t);
                    }
                }
                if (!SetForegroundWindow(t))
                {
                    // 兜底二：抖一下 Alt，让系统认为"刚有输入"，前台锁随之放开。
                    keybd_event(0x12, 0, 0, UIntPtr.Zero);
                    SetForegroundWindow(t);
                    keybd_event(0x12, 0, 2, UIntPtr.Zero);
                }
            }
        }
        catch { }

        // ③ 收工：渲染循环看到这个标记就 break，窗口随即销毁（卡片消失）。
        clickRequested = true;
    }

    /// <summary>
    /// 算出当前卡片的命中矩形（**屏幕坐标**）。
    /// 必须跟 DrawCard 的变换完全一致：那里是「绕 (w/2, cy) 做 scale」，
    /// 所以这里用同一个支点把四个角变换过去。
    /// </summary>
    static void UpdateHitRect(int w, double dpi, double scale, int vx, int vy)
    {
        double s = dpi / 96.0;
        float cw = (float)(440.0 * s);
        float ch = (float)(78.0 * s);
        float cy = (float)(52.0 * s);
        float cx = (float)((w - cw) / 2.0);
        float k = (float)scale;
        float px = w / 2f, py = cy;
        float l = px + (cx - px) * k;
        float t = py + (cy - py) * k;
        float r = px + ((cx + cw) - px) * k;
        float b = py + ((cy + ch) - py) * k;
        hitRect = RectangleF.FromLTRB(l + vx, t + vy, r + vx, b + vy);
    }

    // ── 绘制原语 ─────────────────────────────────────────────────────────────
    static void HsvToRgb(double h, double s, double v, out int r, out int g, out int b)
    {
        h = ((h % 360.0) + 360.0) % 360.0;
        double c = v * s;
        double hp = h / 60.0;
        double xx = c * (1 - Math.Abs((hp % 2) - 1));
        double m = v - c;
        double r1 = 0, g1 = 0, b1 = 0;
        if (hp < 1) { r1 = c; g1 = xx; }
        else if (hp < 2) { r1 = xx; g1 = c; }
        else if (hp < 3) { g1 = c; b1 = xx; }
        else if (hp < 4) { g1 = xx; b1 = c; }
        else if (hp < 5) { r1 = xx; b1 = c; }
        else { r1 = c; b1 = xx; }
        r = (int)Math.Round((r1 + m) * 255.0);
        g = (int)Math.Round((g1 + m) * 255.0);
        b = (int)Math.Round((b1 + m) * 255.0);
    }

    static GraphicsPath RoundRect(RectangleF r, float radius)
    {
        var path = new GraphicsPath();
        float d = radius * 2f;
        if (d <= 0) { path.AddRectangle(r); return path; }
        path.AddArc(r.X, r.Y, d, d, 180, 90);
        path.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        path.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        path.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    static Font PickFont(float px, FontStyle style)
    {
        string[] families = new string[] { "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI" };
        foreach (string f in families)
        {
            try { return new Font(f, px, style, GraphicsUnit.Pixel); } catch { }
        }
        return new Font(FontFamily.GenericSansSerif, px, style, GraphicsUnit.Pixel);
    }

    /// <summary>色相查表：256 档预计算，避免每像素做浮点 HSV（真机 2160x1440 下的主要开销）。</summary>
    static int[] BuildPalette()
    {
        var pal = new int[256];
        for (int i = 0; i < 256; i++)
        {
            int r, g, b;
            HsvToRgb(i * 360.0 / 256.0, 0.85, 1.0, out r, out g, out b);
            pal[i] = (r << 16) | (g << 8) | b;
        }
        return pal;
    }

    /// ⚠️ 清除范围**必须与 <see cref="DrawGlow"/> 画过的范围逐像素一致**：
    /// 四条条带的宽度都是 <see cref="BandSpan"/>（比 `fade` 多出角上那点倒圆余量），
    /// 只清 `fade` 宽的话，光效结束后角上会留下一圈残影。
    static void ClearStrips(byte[] buf, int stride, int w, int h, int fade)
    {
        int span = BandSpan(fade);
        ClearBox(buf, stride, w, h, new RectangleF(0, 0, w, span));
        ClearBox(buf, stride, w, h, new RectangleF(0, h - span, w, span));
        ClearBox(buf, stride, w, h, new RectangleF(0, span, span, h - span * 2));
        ClearBox(buf, stride, w, h, new RectangleF(w - span, span, span, h - span * 2));
    }

    /// <summary>
    /// 相位查表缓存：`(w, h, fade)` → 每像素的角度相位（0..255）。
    /// 见 <see cref="PhaseTable"/> 的说明。
    /// </summary>
    static byte[] phaseTable = null;
    static string phaseKey = null;

    /// <summary>
    /// 相位查表：**把四个角按半径 r 倒圆之后的周长参数**。
    ///
    /// ## 为什么不是"按最近边的周长参数"（真机上肉眼可见的一个 bug）
    ///
    /// 原来的实现按"最近边"把像素分配到四条边，再取该边上的位置当相位。
    /// 问题在于：**最近边的分界线正好是 45° 对角线**，而两条边的周长参数在角上
    /// 相差约一个屏宽 —— 于是每个角都出现一条 45° 的硬边。
    /// 用户的原话："边框效果在每一个角的地方出现了一个 45° 线的隔离"。
    ///
    /// ## 为什么也不用"从中心看过去的角度"
    ///
    /// 角度参数虽然连续，但**速度不均匀**：实测同一条边内快慢能差 3 倍，
    /// 彩虹会在边的中段挤成一团。所以不采用。
    ///
    /// ## 现在这个：倒圆角 + 周长参数
    ///
    /// 把矩形当成"四角半径 r 的圆角矩形"，取沿边界的**弧长**当相位。
    /// 直边与圆弧上都是匀速（`d(相位)/d(弧长)` 恒为 `1/周长`），
    /// 且两段在切点处参数**天然相等** ⇒ 既无缝又匀速。
    ///
    /// 实测（`.workbuddy-ai/verify-phase-seam.mjs`，1920×1080 / 羽化 70px，
    /// 只统计 feather > 0.15 的**可见**像素）：
    ///   旧算法   可见区最大相邻跳变 **115.3°**（就是那条 45° 硬边）
    ///   角度     0.12°，但同边内快慢比 3.01×
    ///   本算法   **0.16°**，长短边比与同边内快慢比都是 **1.000×**
    ///
    /// 代价：`Atan2` 很贵，所以**算一次存表**（按尺寸缓存），每帧只是查表 + 一个整数加。
    /// 只算四条边带里的像素（中间那片根本不画）。表大小 = w × h 字节
    /// （1080p 约 2 MB、4K 约 8 MB），尺寸变化时重建。
    ///
    /// ⚠️ **"不画"的判据必须是"两个方向都超出羽化带"，不能只看一个方向。**
    ///    看错了方向的后果不是"慢一点"，而是**整条边的中段没有相位**——
    ///    见下面循环里的注释。这个错曾经在真机上活了一版（v1.2.0），
    ///    表现为"边框是一块纯色"（用户原话），当时的校验脚本恰好用了同一条错判据
    ///    去采样，所以两边一起错、谁也没报出来。
    /// </summary>
    /// <param name="w">虚拟屏宽（物理像素）。</param>
    /// <param name="h">虚拟屏高（物理像素）。</param>
    /// <param name="fade">羽化宽度（物理像素）；决定哪些像素需要算。</param>
    /// <summary>
    /// 角上倒圆宽度相对羽化宽度的倍数 —— **"弧度大小"就这一个旋钮**。
    ///
    /// 调参记录：
    ///   1.0× → k = 46px，弧半径 ≈ 23px。用户：「弧度再小一点」。
    ///   0.5× → k = 23px，弧半径 ≈ 11.5px，45° 处外扩 ≈ 5.75px。**当前值**。
    ///   0   → 退回纯直角（此时直边上与"离最近边的距离"逐点相同）。
    ///
    /// 预览器（`donevoice-border-preview.html`）里「角上倒圆」滑条就是这个倍数，
    /// 定稿后把这里改成同一个数即可。
    /// </summary>
    const double CornerFadeScale = 0.5;

    /// <summary>
    /// 角上"轻轻倒圆"的平滑宽度 `k`（物理像素）= <see cref="CornerFadeScale"/> × 羽化宽度。
    ///
    /// 注意它**不是"圆弧半径"**：它是一个**平滑最小值**的混合宽度（见 <see cref="SMin"/>），
    /// 效果是把直角 L 的内角轻轻倒圆：内边界沿 45° 对角线**外扩 `k/4`**
    /// （因为 `SMin(t, t, k) = t - k/4`），角上那段等值线的**曲率半径 ≈ `k/2`**。
    /// 两个量都随 `k` 线性变化，所以"弧度大小"就是 `k` 这一个旋钮。
    /// 取 0 就退回纯直角（此时直边上与"离最近边的距离"逐点相同）。
    /// </summary>
    static int CornerRound(int fade)
    {
        return Math.Max(0, (int)Math.Round(fade * CornerFadeScale));
    }

    /// <summary>
    /// 画 / 清边带要扫多远：`fade` 再加角上那点倒圆余量。
    /// `SMin <= min` 且最多小 `k/4`，所以"可画"的区域最多比 `fade` 外扩 `k/4`。
    /// </summary>
    static int BandSpan(int fade)
    {
        return fade + (CornerRound(fade) + 3) / 4 + 1;
    }

    /// <summary>
    /// **相位路径**的圆角半径 —— 只用来参数化颜色（见 <see cref="PhaseTable"/>），**不参与 alpha**。
    ///
    /// 为什么它必须 ≥ <see cref="BandSpan"/>：
    /// 相位按"离哪条边最近"来分配参数，而四条边的参数在 **45° 对角线上对不上**
    /// （相差正好是 `arc = πR/2`）。所以半径 `R` 的角方块必须**盖住整个可画的角区**，
    /// 那条 45° 接缝才会落在羽化带**外面**、看不见。取 `R = BandSpan + 2` 留一点余量。
    ///
    /// ⚠️ 反面教材：上一版把 `R` 取成 `2×fade` 去"倒圆角"，结果等距面在屏幕角外侧变成负数、
    /// 钳到 0 之后整块三角区满亮 ⇒ 用户报的"角上这么厚实"。倒圆该由 <see cref="SMin"/> 做，
    /// 不应该靠放大路径半径。
    /// </summary>
    static int PathRadius(int w, int h, int fade)
    {
        int r = BandSpan(fade) + 2;
        return Math.Max(1, Math.Min(r, Math.Min(w, h) / 2 - 1));
    }

    /// <summary>
    /// 平滑最小值（多项式 smin，Inigo Quilez 那一版）：`|a - b| >= k` 时**恒等于** `min(a, b)`，
    /// 只在角上那 `k` 宽的带子里把直角"倒圆"。
    ///
    /// 为什么用它而不是"到圆角弧的距离"：后者的等距面在**屏幕角外侧**（弧与屏幕角之间那块）
    /// 是负的，钳到 0 之后整块三角区都成了满亮度 —— 角上凭空鼓出一大团。
    /// `SMin <= min`，只会让角上**略亮一丁点**，绝不会出现"越靠角越暗"的间隙。
    /// 这正是要的效果：**没有间隙、自然连过去、只有微微弧度**。
    /// </summary>
    static double SMin(double a, double b, double k)
    {
        if (k <= 0) return Math.Min(a, b);
        double h = 0.5 + 0.5 * (b - a) / k;
        if (h < 0) h = 0; else if (h > 1) h = 1;
        return b + h * (a - b) - k * h * (1 - h);
    }

    /// <summary>
    /// 某一像素"到边框路径的距离"。**直边上** `= min(dx, dy)`（离最近边的距离）；
    /// **角上**用 <see cref="SMin"/> 把直角轻轻倒圆。
    ///
    /// ⚠️ 建表（<see cref="PhaseTable"/>）与绘制（<see cref="DrawGlow"/>）的判据都**必须走它**：
    /// 两边只要有一处不一致，就会出现"会画但没算相位"的像素 —— 它们拿到表里的默认值 `0`，
    /// 在角上画出一块固定的红（色相 0）色块。
    /// </summary>
    /// <param name="x">横坐标。</param>
    /// <param name="y">纵坐标。</param>
    /// <param name="w">宽。</param>
    /// <param name="h">高。</param>
    /// <param name="dy">调用方算好的 `min(y, h-1-y)`（省一次重复计算）。</param>
    /// <param name="k">角上倒圆的平滑宽度，见 <see cref="CornerRound"/>。</param>
    /// <returns>到边框路径的距离（可能大于 fade，表示这一像素不画）。</returns>
    static double BandDistance(int x, int y, int w, int h, int dy, int k)
    {
        double dx = Math.Min(x, w - 1 - x);
        double d = SMin(dx, dy, k);
        return d > 0 ? d : 0;
    }

    /// <returns>长度 w*h 的相位表。</returns>
    static byte[] PhaseTable(int w, int h, int fade)
    {
        string key = w + "x" + h + "x" + fade;
        if (phaseTable != null && phaseKey == key) return phaseTable;

        // 角上倒圆的平滑宽度（只影响 alpha 判据）与相位路径半径（只影响颜色参数化）。
        int k = CornerRound(fade);
        int r = PathRadius(w, h, fade);
        double sw = w - 2.0 * r; // 上/下直边长度
        double sh = h - 2.0 * r; // 左/右直边长度
        double arc = Math.PI * r / 2.0; // 每段圆弧的弧长
        double per = 2 * sw + 2 * sh + 4 * arc;
        const double HALF = Math.PI / 2.0;
        int rMax = w - 1 - r; // 右边界（含）
        int bMax = h - 1 - r; // 下边界（含）

        var table = new byte[w * h];
        for (int y = 0; y < h; y++)
        {
            int dy = Math.Min(y, h - 1 - y);
            int row = y * w;
            bool nearTop = y < r;
            bool nearBottom = y > bMax;
            for (int x = 0; x < w; x++)
            {
                // ⚠️ **曾经这里是 `if (dx >= fade) continue;`，是个致命的漏判**：
                //    一条边的**中段**恰好满足 `dy < fade` 但 `dx >= fade`（它离左右两边很远），
                //    于是整段中段被跳过、相位恒为 0 ⇒ **整条边只有一个颜色**，
                //    只有四个角的 fade×fade 方块才拿到真相位。
                //    真机观感就是用户报的"边框是一大块纯色、只在四个角上有颜色"。
                //    现在的判据 = 绘制判据本身（`d < fade` 才需要相位），逐像素对齐，不会再错位。
                if (BandDistance(x, y, w, h, dy, k) >= fade) continue;
                int dx = Math.Min(x, w - 1 - x);
                bool nearLeft = x < r;
                bool nearRight = x > rMax;
                double p;
                // 判定顺序：**先四角、后四边**。半径按 PathRadius 取（≥ BandSpan + 2），
                // 所以四个 r×r 角方块一定盖住整个可画的角区，那条 45° 参数接缝落在带外。
                if (nearTop && nearLeft) p = r * (HALF - Math.Atan2(r - x, r - y));
                else if (nearTop && nearRight) p = arc + sw + r * Math.Atan2(x - (w - r), r - y);
                else if (nearBottom && nearRight) p = 2 * arc + sw + sh + r * Math.Atan2(y - (h - r), x - (w - r));
                else if (nearBottom && nearLeft) p = 3 * arc + 2 * sw + sh + r * Math.Atan2(r - x, y - (h - r));
                // 四条直边按"离哪条最近"分配。⚠️ 不能写成"兜底就给右边"：
                // 那是上一版的写法，靠"可画区域内 x、y 不可能同时远离两边"侥幸成立；
                // 现在角上多了倒圆余量，那个前提不再严谨，所以老老实实比一次。
                else if (dy <= dx) p = y < h / 2 ? arc + (x - r) : 3 * arc + sw + sh + (w - r - x);
                else p = x < w / 2 ? 4 * arc + 2 * sw + sh + (h - r - y) : 2 * arc + sw + (y - r);
                // ★ 周长上绕 2 圈彩虹：颜色变化频率翻倍，避免"一条边一种纯色"。
                double t = (p / per) * 2.0;
                t = t - Math.Floor(t);
                table[row + x] = (byte)(((int)(t * 256.0)) & 0xFF);
            }
        }
        // ★ 修复四个圆心点的 Atan2(0,0) 异常：圆心不是圆弧上的点，
        //    Atan2(0,0)=0 会让它的 phase 与周围邻居差约 arc/2，形成颜色斑点。
        //    用上下左右四个邻居的平均值覆盖圆心。
        if (r >= 1)
        {
            FixCornerCenter(table, w, h, fade, r, r);
            FixCornerCenter(table, w, h, fade, w - 1 - r, r);
            FixCornerCenter(table, w, h, fade, w - 1 - r, h - 1 - r);
            FixCornerCenter(table, w, h, fade, r, h - 1 - r);
        }
        phaseTable = table;
        phaseKey = key;
        return table;
    }

    /// <summary>用四邻域平均值覆盖角方块圆心（排除圆心自身），消除 Atan2(0,0) 斑点。</summary>
    static void FixCornerCenter(byte[] table, int w, int h, int fade, int cx, int cy)
    {
        int sum = 0, n = 0;
        int[] nx = { -1, 1, 0, 0 };
        int[] ny = { 0, 0, -1, 1 };
        for (int i = 0; i < 4; i++)
        {
            int xx = cx + nx[i], yy = cy + ny[i];
            if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
            int ddy = Math.Min(yy, h - 1 - yy);
            if (BandDistance(xx, yy, w, h, ddy, CornerRound(fade)) >= fade) continue; // 邻居不在羽化带内，不参与
            sum += table[yy * w + xx];
            n++;
        }
        if (n > 0) table[cy * w + cx] = (byte)((sum + n / 2) / n); // 四舍五入取平均
    }

    /// <summary>把某一帧的四边光效写进 buffer（只遍历四条边带，不扫全屏）。</summary>
    /// <param name="phaseTable">由 <see cref="PhaseTable"/> 预先算好的角度相位表。</param>
    static void DrawGlow(byte[] buf, int stride, int w, int h, int fade, double intensity, double phase, int[] pal, byte[] phaseTable)
    {
        double fadeD = fade * 1.0;
        // 动画偏移折成 0..255 的整数，与查表值相加后取低 8 位 —— 一圈刚好走完一个循环。
        int shift = ((int)(phase * 256.0)) & 0xFF;
        // 角上倒圆的平滑宽度 + 边带要扫多远（fade 再加角上那点倒圆余量）。
        int k = CornerRound(fade);
        int span = BandSpan(fade);
        // 只扫四个条带（中间大片根本不碰）。★ **四条条带的宽度都取 `span`**（不是 `fade`）：
        //   角上被 SMin 倒圆之后，`d < fade` 的区域比纯直角版大一圈 —— 精确地说
        //   `d >= min(dx, dy) - k/4`，所以"可画"一定落在 `min(dx, dy) < fade + k/4 < span` 内，
        //   也就是"**四条各 span 宽的条带**"的并集。只扫 fade 宽会在角上留下
        //   "该画却没扫到"的像素（表现为角上缺一块 / 台阶）—— `.workbuddy-ai/verify-corner-join.mjs`
        //   里那条"可画点必须落在条带并集内"就是专门抓它的。
        for (int band = 0; band < 4; band++)
        {
            int x0, x1, y0, y1;
            if (band == 0) { x0 = 0; x1 = w; y0 = 0; y1 = span; }
            else if (band == 1) { x0 = 0; x1 = w; y0 = h - span; y1 = h; }
            else if (band == 2) { x0 = 0; x1 = span; y0 = span; y1 = h - span; }
            else { x0 = w - span; x1 = w; y0 = span; y1 = h - span; }
            for (int y = y0; y < y1; y++)
            {
                int dy = Math.Min(y, h - 1 - y);
                int rowOff = y * stride;
                int trow = y * w;
                for (int x = x0; x < x1; x++)
                {
                    double d = BandDistance(x, y, w, h, dy, k);
                    if (d >= fade) continue;
                    double feather = 1.0 - d / fadeD;
                    feather = feather * feather;
                    int a = (int)(intensity * feather * 235.0);
                    if (a <= 0) continue;
                    int rgb = pal[(phaseTable[trow + x] + shift) & 255];
                    int off = rowOff + x * 4;
                    buf[off + 0] = (byte)(((rgb & 0xFF) * a) / 255);
                    buf[off + 1] = (byte)((((rgb >> 8) & 0xFF) * a) / 255);
                    buf[off + 2] = (byte)((((rgb >> 16) & 0xFF) * a) / 255);
                    buf[off + 3] = (byte)a;
                }
            }
        }
    }

    // ── BEGIN dsh-mark (由 .workbuddy-ai/embed-mark.py 生成，勿手改) ──
    // DSH 的官方图标（白底圆角方块 + 深色鲸鱼），就是系统通知里那个。
    // 来源：从 DSH 安装包 `deepseek-harness-*-win-x64.exe` 抽出的 256px 图标资源，
    //       切掉自带投影、缩到 96px（见 `.workbuddy-ai/extract-icon.py` / `make-mark.py`）。
    // 为什么要嵌 base64：worker.ps1 是把这份源码文本拼进去交给 Add-Type 编译的，
    // C# 侧拿不到插件目录，嵌进源码最省事（8409 字节 → base64 11212 字符）。
    const string DshMarkBase64 =
        "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"
        + "AElFTkSuQmCC";

    static Bitmap dshMark = null;

    /// <summary>懒加载 DSH 标识位图（只解一次，之后每帧复用）。解不出来就返回 null。</summary>
    static Bitmap DshMark()
    {
        if (dshMark != null) return dshMark;
        try
        {
            byte[] bytes = Convert.FromBase64String(DshMarkBase64);
            using (var ms = new System.IO.MemoryStream(bytes))
            {
                // 必须**复制**一份：GDI+ 位图会一直引用这个流，而 using 结束就把流关了。
                using (var tmp = new Bitmap(ms))
                    dshMark = new Bitmap(tmp);
            }
        }
        catch { dshMark = null; }
        return dshMark;
    }
    // ── END dsh-mark ──

    // 卡片版式（逻辑像素 @96dpi；实际绘制时统一乘 `dpi/96`）。
    //   竖条  cx+7 起、3px 宽（事件类型色）
    //   标识  cx+16 起、32px 见方、垂直居中（DSH 官方图标）
    //   文字  标识右边 11px 起，右边距 12px ⇒ 宽度 = 440 − 59 − 12 = 369px，居中
    const float MarkLeft = 16f;
    const float MarkSize = 32f;
    const float MarkGap = 11f;
    const float TEXT_PAD_R = 12f;

    /// <summary>卡片 + 投影的包围盒（逻辑像素，已按 DPI 缩放）；每帧必须先把它清零。</summary>
    static RectangleF CardBox(int w, double dpi)
    {
        double s = dpi / 96.0;
        float cw = (float)(440.0 * s);
        float ch = (float)(78.0 * s);
        float cy = (float)(52.0 * s);
        float cx = (float)((w - cw) / 2.0);
        float pad = (float)(16.0 * s);
        return new RectangleF(cx - pad, cy - pad, cw + pad * 2f, ch + pad * 2.6f);
    }

    static void ClearBox(byte[] buf, int stride, int w, int h, RectangleF box)
    {
        int x0 = Math.Max(0, (int)Math.Floor(box.Left));
        int x1 = Math.Min(w, (int)Math.Ceiling(box.Right));
        int y0 = Math.Max(0, (int)Math.Floor(box.Top));
        int y1 = Math.Min(h, (int)Math.Ceiling(box.Bottom));
        if (x1 <= x0 || y1 <= y0) return;
        int bytes = (x1 - x0) * 4;
        for (int y = y0; y < y1; y++)
        {
            int off = y * stride + x0 * 4;
            for (int i = 0; i < bytes; i++) buf[off + i] = 0;
        }
    }

    static void DrawCard(Graphics g, int w, double dpi, string title, string body, string accentHex, double alpha, double scale)
    {
        double s = dpi / 96.0;
        float cw = (float)(440.0 * s);
        float ch = (float)(78.0 * s);
        float cy = (float)(52.0 * s);
        float cx = (float)((w - cw) / 2.0);
        int A = (int)Math.Max(0, Math.Min(255, Math.Round(alpha * 255.0)));
        if (A <= 0) return;

        GraphicsState st = g.Save();
        g.TranslateTransform(w / 2f, cy);
        g.ScaleTransform((float)scale, (float)scale);
        g.TranslateTransform(-w / 2f, -cy);

        // ⚠️ **刻意不画投影**。
        //    原来这里是"三层逐级放大的圆角矩形，每层 10% 黑"冒充柔化投影。
        //    但 GDI+ 没有廉价的模糊，三层实心块叠出来的**必然是一圈圈硬边**——
        //    真机上看着就是卡片底下压着一张重影（用户原话："不要带有下面的重影"）。
        //    卡片本身是深色实底 + 1px 描边，在浅色与深色壁纸上都够清楚，不需要投影。
        var bodyRect = new RectangleF(cx, cy, cw, ch);
        using (var p = RoundRect(bodyRect, 16f * (float)s))
        using (var br = new SolidBrush(Color.FromArgb((int)(A * 0.95), 24, 24, 28)))
            g.FillPath(br, p);
        using (var p = RoundRect(bodyRect, 16f * (float)s))
        using (var pen = new Pen(Color.FromArgb((int)(A * 0.16), 255, 255, 255), 1f))
            g.DrawPath(pen, p);

        int ar = 120, ag = 190, ab = 255;
        try
        {
            if (accentHex != null && accentHex.Length == 7 && accentHex[0] == '#')
            {
                ar = Convert.ToInt32(accentHex.Substring(1, 2), 16);
                ag = Convert.ToInt32(accentHex.Substring(3, 2), 16);
                ab = Convert.ToInt32(accentHex.Substring(5, 2), 16);
            }
        }
        catch { }
        // 强调色竖条：贴**最左边**（3px 宽），标出这次事件的类型（完成/审批/提问/失败）。
        var barRect = new RectangleF(cx + 7f * (float)s, cy + 20f * (float)s, 3f * (float)s, ch - 40f * (float)s);
        using (var p = RoundRect(barRect, 1.5f * (float)s))
        using (var br = new SolidBrush(Color.FromArgb(A, ar, ag, ab)))
            g.FillPath(br, p);

        // ── DSH 标识（卡片左侧那个小图标）─────────────────────────────────────
        // 版式照抄系统通知：**左边一个 App 图标，右边是内容**。
        // 图标就是 DSH 官方那个（白底圆角方块 + 深色鲸鱼），与系统通知里看到的一致。
        // 逻辑尺寸 32px、距卡片左边 16px、垂直居中；方块自带白底，
        // 在深色卡片上自带对比，不需要额外描边。
        Bitmap mark = DshMark();
        if (mark != null)
        {
            float ms = MarkSize * (float)s;
            float mx = cx + MarkLeft * (float)s;
            float my = cy + (ch - ms) / 2f;
            // 96px → 32px 是缩小，双三次 + HighQuality 像素偏移才不会出现锯齿；
            // TileFlipXY 让采样越过边界时做镜像，避免透明边缘把方块四角啃出灰边。
            InterpolationMode oldInterp = g.InterpolationMode;
            PixelOffsetMode oldOffset = g.PixelOffsetMode;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            using (var ia = new ImageAttributes())
            {
                ia.SetWrapMode(WrapMode.TileFlipXY);
                // ⚠️ 这里**必须**用整数 `Rectangle` 重载：.NET Framework 的 Graphics 里，
                //    带 `ImageAttributes` 的 DrawImage 重载**只有** `Rectangle` 版本，
                //    `RectangleF` 那一组没有。写 `new RectangleF(...)` 会编译失败，真机报错：
                //      「与 DrawImage(Image, Rectangle, float,float,float,float, GraphicsUnit,
                //        ImageAttributes) 最匹配的重载方法具有一些无效参数」
                //    坐标取整不影响观感：这里本来就是缩小采样，亚像素定位由 PixelOffsetMode 负责。
                g.DrawImage(mark, new Rectangle((int)Math.Round(mx), (int)Math.Round(my), (int)Math.Round(ms), (int)Math.Round(ms)),
                            0f, 0f, mark.Width, mark.Height, GraphicsUnit.Pixel, ia);
            }
            g.InterpolationMode = oldInterp;
            g.PixelOffsetMode = oldOffset;
        }

        bool hasBody = body != null && body.Length > 0;
        using (var fTitle = PickFont(16.5f * (float)s, FontStyle.Bold))
        using (var fBody = PickFont(13f * (float)s, FontStyle.Regular))
        using (var bTitle = new SolidBrush(Color.FromArgb(A, 245, 245, 247)))
        using (var bBody = new SolidBrush(Color.FromArgb((int)(A * 0.72), 235, 235, 240)))
        using (var fmt = new StringFormat(StringFormatFlags.NoWrap))
        {
            fmt.Trimming = StringTrimming.EllipsisCharacter;
            // ★ 文字**居中**（用户定稿："文字要居中，这样更有美感"）。
            //   加了 DSH 标识之后，居中范围从"整张卡片"改成"标识右侧那一块"
            //   （右内边距仍留 TEXT_PAD_R）—— 否则长标题会压到图标上。
            fmt.Alignment = StringAlignment.Center;
            float textX = cx + (MarkLeft + MarkSize + MarkGap) * (float)s;
            float textW = cw - (MarkLeft + MarkSize + MarkGap + TEXT_PAD_R) * (float)s;
            float titleY = hasBody ? cy + 15f * (float)s : cy + (ch - 22f * (float)s) / 2f;
            g.DrawString(title == null ? "" : title, fTitle, bTitle, new RectangleF(textX, titleY, textW, 24f * (float)s), fmt);
            if (hasBody)
                g.DrawString(body, fBody, bBody, new RectangleF(textX, cy + 41f * (float)s, textW, 22f * (float)s), fmt);
        }
        g.Restore(st);
    }

    // ── 对外：离线渲染一帧到 PNG（用来核对观感，不创建窗口） ──────────────────
    public static string SaveFrame(string path, int w, int h, double fade, double intensity, double phase,
                                   string title, string body, string accentHex, double cardAlpha, double cardScale, double dpi)
    {
        try
        {
            int fadeI = (int)Math.Max(1, Math.Round(fade));
            using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppPArgb))
            {
                var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
                int stride = data.Stride;
                var buf = new byte[stride * h];
                DrawGlow(buf, stride, w, h, fadeI, intensity, phase, BuildPalette(), PhaseTable(w, h, fadeI));
                Marshal.Copy(buf, 0, data.Scan0, buf.Length);
                bmp.UnlockBits(data);
                if (cardAlpha > 0.002)
                {
                    using (Graphics g = Graphics.FromImage(bmp))
                    {
                        g.SmoothingMode = SmoothingMode.AntiAlias;
                        g.TextRenderingHint = TextRenderingHint.AntiAlias;
                        DrawCard(g, w, dpi, title, body, accentHex, cardAlpha, cardScale);
                    }
                }
                bmp.Save(path, ImageFormat.Png);
            }
            return "ok";
        }
        catch (Exception ex) { return "error: " + ex.Message; }
    }

    // ── 对外：真正显示 / 收起 ────────────────────────────────────────────────
    // glowMs     边框光效总时长（= 音效时长，死逻辑由宿主算好传进来）
    // cardMs     顶部卡片停留时长
    // fade       羽化宽度（物理像素，宿主已按 DPI 折算）
    // speedPct   流速百分比（100 = 一圈 7.5s）
    // dshHwnd    DSH 主窗口句柄；点击卡片后要把它拿回前台（0 = 拿不到，只写标记）
    // markerPath 点击标记文件路径；页面聚焦后读它来决定跳哪条会话
    public static string Show(double dpi, int fade, double intensity, double speedPct, int glowMs, int cardMs,
                              string title, string body, string accentHex, long dshHwnd, string markerPath)
    {
        int gen;
        Thread old;
        lock (gate)
        {
            // ★ 先自增再取旧线程：旧线程下一轮循环就会看到 generation 变了，自己退出。
            generation += 1;
            gen = generation;
            old = thread;
            thread = null;
        }
        // ★ Join 必须在锁**外**。旧线程的循环体要拿同一把锁才能读到 generation，
        //   持锁 Join 会让它永远拿不到锁 ⇒ 必然等满超时（实测：每次重画白等 400ms）。
        if (old != null && old.IsAlive)
        {
            try { old.Join(400); } catch { }
        }

        try { SetProcessDPIAware(); } catch { }
        int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77), vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
        if (vw <= 0 || vh <= 0) return "{\"ok\":false,\"error\":\"no-screen\"}";

        var t = new Thread(delegate ()
        {
            RunOverlay(gen, vx, vy, vw, vh, dpi, fade, intensity, speedPct, glowMs, cardMs, title, body, accentHex,
                       dshHwnd, markerPath);
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.MTA);
        lock (gate) { thread = t; }
        t.Start();
        return "{\"ok\":true,\"gen\":" + gen + ",\"x\":" + vx + ",\"y\":" + vy + ",\"w\":" + vw + ",\"h\":" + vh + "}";
    }

    public static string Hide()
    {
        int gen;
        lock (gate)
        {
            generation += 1;
            gen = generation;
        }
        return "{\"ok\":true,\"hidden\":true,\"gen\":" + gen + "}";
    }

    /// <summary>覆盖层线程主体：建窗 → 每帧合成 → UpdateLayeredWindow → 到时销毁。</summary>
    static void RunOverlay(int gen, int vx, int vy, int vw, int vh, double dpi, int fade, double intensity,
                           double speedPct, int glowMs, int cardMs, string title, string body, string accentHex,
                           long dshHwnd, string markerPath)
    {
        IntPtr hwnd = IntPtr.Zero;
        lastOk = false;
        frames = 0;
        shownAtTicks = DateTime.UtcNow.Ticks;
        // 点击相关的状态是**进程级静态**（WndProc 是静态方法，拿不到实例状态）：
        // 每次 Show 覆盖一次即可，同时把上一次残留的点击标记清掉。
        dshWindow = (IntPtr)dshHwnd;
        clickMarkerPath = markerPath;
        clickRequested = false;
        hitAlpha = 0.0;
        hitRect = RectangleF.Empty;
        try { SetProcessDPIAware(); } catch { }

        int fadeI = Math.Max(1, Math.Min(220, fade));
        double spinMs = 7500.0 / (Math.Max(30.0, Math.Min(220.0, speedPct)) / 100.0);
        // 淡出占光效时长的 35%（上限 450ms、下限 120ms），与页面版同一条规则。
        int glowFadeMs = Math.Max(120, Math.Min(450, (int)Math.Round(glowMs * 0.35)));
        int appearMs = 220;
        int cardExitMs = 260;
        long totalMs = Math.Max(glowMs, cardMs + cardExitMs) + 60;

        var buf = new byte[vw * 4 * vh];
        int[] pal = BuildPalette();
        // 角度相位表**只算一次**（Atan2 很贵，每帧算扛不住）；见 PhaseTable 的说明。
        byte[] phaseTab = PhaseTable(vw, vh, fadeI);
        using (var bmp = new Bitmap(vw, vh, PixelFormat.Format32bppPArgb))
        {
            IntPtr screenDc = GetDC(IntPtr.Zero);
            IntPtr memDc = CreateCompatibleDC(screenDc);
            IntPtr hBmp = IntPtr.Zero;
            IntPtr oldBmp = IntPtr.Zero;
            try
            {
                // ⚠️ **不再带 WS_EX_TRANSPARENT** —— 带了它就完全收不到鼠标消息，卡片就点不动。
                //    穿透改由 WndProc 的 WM_NCHITTEST 按区域决定：卡片外仍然 HTTRANSPARENT。
                if (!EnsureWindowClass()) { lastOk = false; return; }
                hwnd = CreateWindowEx(
                    WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
                    OVERLAY_CLASS, "DoneVoiceOverlay", WS_POPUP, vx, vy, vw, vh, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
                if (hwnd == IntPtr.Zero) { lastOk = false; return; }

                var sw = Stopwatch.StartNew();
                var frameSw = new Stopwatch();
                while (true)
                {
                    int curGen;
                    lock (gate) { curGen = generation; }
                    if (curGen != gen) break;
                    long el = sw.ElapsedMilliseconds;
                    if (el > totalMs) break;
                    frameSw.Restart();

                    double phase = (el % spinMs) / spinMs;
                    // 光效整体透明度：进场 120ms 淡入 + 收尾按 glowFadeMs 淡出。
                    double gAlpha = 1.0;
                    if (el < 120) gAlpha = el / 120.0;
                    if (el > glowMs - glowFadeMs) gAlpha = Math.Min(gAlpha, Math.Max(0.0, (glowMs - el) / (double)glowFadeMs));
                    if (el > glowMs) gAlpha = 0.0;

                    double cAlpha = 1.0, cScale = 1.0;
                    if (el < appearMs)
                    {
                        double k = el / (double)appearMs;
                        cAlpha = k;
                        // 果冻弹出：0.94 → 1.02 → 1.00（过冲后回弹）
                        cScale = k < 0.7 ? 0.94 + (1.02 - 0.94) * (k / 0.7) : 1.02 - 0.02 * ((k - 0.7) / 0.3);
                    }
                    if (el > cardMs) cAlpha = Math.Max(0.0, 1.0 - (el - cardMs) / (double)cardExitMs);
                    if (cardMs <= 0) cAlpha = 0.0;

                    // 把"这一刻卡片在哪、有多不透明"交给 WndProc（它在同一线程被派发，读到的是本帧的值）。
                    // 卡片淡出后 hitAlpha 归零 ⇒ 命中测试一律 HTTRANSPARENT ⇒ 恢复全屏穿透。
                    hitAlpha = cAlpha;
                    if (cAlpha > 0.35) UpdateHitRect(vw, dpi, cScale, vx, vy);

                    // 位图每帧被整块 Marshal.Copy 覆盖，所以**不需要**清任何东西；
                    // 只有光效结束后要把四条边带清回全透明（否则最后一帧会留在屏幕上）。
                    if (gAlpha > 0.002) DrawGlow(buf, vw * 4, vw, vh, fadeI, intensity * gAlpha, phase, pal, phaseTab);
                    else ClearStrips(buf, vw * 4, vw, vh, fadeI);

                    var data = bmp.LockBits(new Rectangle(0, 0, vw, vh), ImageLockMode.WriteOnly, PixelFormat.Format32bppPArgb);
                    Marshal.Copy(buf, 0, data.Scan0, buf.Length);
                    bmp.UnlockBits(data);
                    if (cAlpha > 0.002)
                    {
                        using (Graphics g = Graphics.FromImage(bmp))
                        {
                            g.SmoothingMode = SmoothingMode.AntiAlias;
                            g.TextRenderingHint = TextRenderingHint.AntiAlias;
                            DrawCard(g, vw, dpi, title, body, accentHex, cAlpha, cScale);
                        }
                    }

                    hBmp = bmp.GetHbitmap(Color.FromArgb(0));
                    oldBmp = SelectObject(memDc, hBmp);
                    var size = new SIZE(); size.CX = vw; size.CY = vh;
                    var srcPt = new POINT(); srcPt.X = 0; srcPt.Y = 0;
                    var dstPt = new POINT(); dstPt.X = vx; dstPt.Y = vy;
                    var blend = new BLENDFUNCTION();
                    blend.BlendOp = AC_SRC_OVER; blend.BlendFlags = 0; blend.SourceConstantAlpha = 255; blend.AlphaFormat = AC_SRC_ALPHA;
                    bool pushed = UpdateLayeredWindow(hwnd, screenDc, ref dstPt, ref size, memDc, ref srcPt, 0, ref blend, ULW_ALPHA);
                    SelectObject(memDc, oldBmp);
                    DeleteObject(hBmp);
                    hBmp = IntPtr.Zero;
                    if (!pushed) { lastOk = false; break; }
                    lastOk = true;
                    frames += 1;
                    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    frameSw.Stop();
                    lastFrameMs = (int)frameSw.ElapsedMilliseconds;

                    // 抽消息：命中测试（WM_NCHITTEST）与点击（WM_LBUTTONUP）都在这里被派发。
                    // PeekMessage 不阻塞，所以不拖慢渲染节奏；每帧抽一次就够 ——
                    // 33ms 的命中测试延迟在人眼里就是"光标刚移过去样式就变了"。
                    MSG msg;
                    while (PeekMessage(out msg, IntPtr.Zero, 0, 0, PM_REMOVE))
                    {
                        TranslateMessage(ref msg);
                        DispatchMessage(ref msg);
                    }
                    // 点过了立刻收工：卡片马上消失，不等自然到期。
                    if (clickRequested) break;

                    int sleep = 33 - lastFrameMs;
                    if (sleep > 0) Thread.Sleep(sleep);
                }
            }
            catch
            {
                lastOk = false;
            }
            finally
            {
                if (hBmp != IntPtr.Zero) { try { DeleteObject(hBmp); } catch { } }
                if (memDc != IntPtr.Zero) { try { DeleteDC(memDc); } catch { } }
                if (screenDc != IntPtr.Zero) { try { ReleaseDC(IntPtr.Zero, screenDc); } catch { } }
                if (hwnd != IntPtr.Zero) { try { DestroyWindow(hwnd); } catch { } }
            }
        }
        lock (gate) { if (generation == gen) thread = null; }
    }
}
