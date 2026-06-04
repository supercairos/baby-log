/**
 * Auth gate. Scan the Baby Buddy "Add a device" QR (via the browser BarcodeDetector) or
 * enter server + token manually. The full `BABYBUDDY-LOGIN:` payload can also be pasted
 * into the address field. Every path validates with `GET /api/children/` before saving.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { type Connection, connectionFromManual, parseLoginQr, validateConnection } from "../api";
import { useStyles } from "../theme";
import { config } from "../config/config";
import { buzz } from "./hooks";
import { ScanIcon } from "../ui/icons";

type Mode = "landing" | "manual" | "scanning" | "connecting";

// BarcodeDetector isn't in the TS DOM lib; declare the slice we use + feature-detect.
interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
}

/**
 * A QR detector using the native BarcodeDetector where available (fast, low-power), else
 * lazily loading the zxing-wasm ponyfill (iOS Safari / Firefox / Linux Chrome). Returns null
 * if neither can be set up. The ponyfill chunk + wasm load only when the native API is absent.
 */
async function getQrDetector(): Promise<BarcodeDetectorLike | null> {
  const Native = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (Native) {
    try {
      return new Native({ formats: ["qr_code"] });
    } catch {
      /* native present but unusable — fall back to the ponyfill */
    }
  }
  try {
    const { getPonyfillDetector } = await import("./scanEngine");
    return getPonyfillDetector() as unknown as BarcodeDetectorLike;
  } catch {
    return null;
  }
}

export function LoginScreen({ onConnect }: { onConnect: (conn: Connection) => void }) {
  const { s } = useStyles();
  const [mode, setMode] = useState<Mode>("landing");
  const [url, setUrl] = useState(config.babyBuddyUrl); // pre-filled from react-env when set
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | undefined>(undefined);

  const stopCamera = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const connectWith = useCallback(
    async (conn: Connection, fallback: Mode) => {
      buzz();
      stopCamera();
      setErr("");
      setMode("connecting");
      const res = await validateConnection(conn);
      if (res.ok) {
        onConnect(conn);
        return;
      }
      setErr(
        res.reason === "unauthorized"
          ? "That token was rejected. Check the API key."
          : res.reason === "unreachable"
            ? "Couldn't reach the server. Check the address and your connection."
            : `Connection failed (HTTP ${res.status}).`,
      );
      setMode(fallback);
    },
    [onConnect, stopCamera],
  );

  const startScan = useCallback(async () => {
    buzz();
    setErr("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setErr("Camera scanning isn't available here — enter your server and token instead.");
      setMode("manual");
      return;
    }
    setMode("scanning");
    const detector = await getQrDetector().catch(() => null);
    if (!detector) {
      setErr("Couldn't start the QR scanner — enter your server and token instead.");
      setMode("manual");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      const tick = async () => {
        if (!streamRef.current) return;
        try {
          const codes = await detector.detect(video);
          const hit = codes.map((c) => parseLoginQr(c.rawValue)).find(Boolean);
          if (hit) {
            await connectWith(hit, "scanning");
            return;
          }
        } catch {
          /* transient decode error — keep scanning */
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch {
      stopCamera();
      setErr("Couldn't open the camera — enter your server and token instead.");
      setMode("manual");
    }
  }, [connectWith, stopCamera]);

  const submitManual = useCallback(() => {
    buzz();
    // Allow pasting the whole `BABYBUDDY-LOGIN:` payload into the address field.
    const pasted = parseLoginQr(url.trim());
    if (pasted) {
      void connectWith(pasted, "manual");
      return;
    }
    if (!url.trim() || !token.trim()) {
      setErr("Enter both the server address and your API token.");
      return;
    }
    void connectWith(connectionFromManual(url, token), "manual");
  }, [url, token, connectWith]);

  const cancelScan = useCallback(() => {
    stopCamera();
    setMode("landing");
  }, [stopCamera]);

  return (
    <div style={s.loginRoot}>
      <div style={s.ambient} />

      <div style={s.loginHero}>
        <div style={s.loginLogo}>·</div>
        <div style={s.loginAppName}>Baby Log</div>
        <div style={s.loginTagline}>A calmer way to track feeds, sleep, and changes — connected to your Baby Buddy.</div>
      </div>

      <div style={s.loginPanel}>
        {mode === "scanning" ? (
          <>
            <video ref={videoRef} playsInline muted style={s.loginVideo} />
            <div style={s.loginScanSub}>Point at your Login QR code…</div>
            {err && <div style={s.loginErr}>{err}</div>}
            <button onClick={cancelScan} style={s.loginTextBtn}>
              ← Cancel
            </button>
          </>
        ) : mode === "connecting" ? (
          <div style={s.loginBusy}>
            <div className="spin" style={s.loginSpinner} />
            <div style={s.loginBusyText}>Connecting…</div>
          </div>
        ) : mode === "manual" ? (
          <>
            <div style={s.loginPanelTitle}>Connect manually</div>
            <div style={s.sheetGroup}>Server address</div>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://babybuddy.example.com"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              inputMode="url"
              style={s.loginInput}
            />
            <div style={s.sheetGroup}>API token</div>
            <input
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Your Baby Buddy API key"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              style={s.loginInput}
            />
            {err && <div style={s.loginErr}>{err}</div>}
            <button onClick={submitManual} style={s.cta}>
              Connect
            </button>
            <button onClick={() => { buzz(); setMode("landing"); setErr(""); }} style={s.loginTextBtn}>
              ← Back
            </button>
          </>
        ) : (
          <>
            <button onClick={startScan} style={s.loginScanBtn}>
              <span style={{ display: "grid", placeItems: "center" }}>
                <ScanIcon size={24} />
              </span>
              Scan Login QR code
            </button>
            <div style={s.loginScanSub}>
              Find it in Baby Buddy under <strong>User → Add a device</strong>
            </div>
            {err && <div style={s.loginErr}>{err}</div>}
            <div style={s.loginDivider}>
              <span style={s.loginDividerLine} />
              <span style={s.loginDividerText}>or</span>
              <span style={s.loginDividerLine} />
            </div>
            <button onClick={() => { buzz(); setMode("manual"); }} style={s.loginManualBtn}>
              Enter address &amp; token manually
            </button>
          </>
        )}
      </div>

      <div style={s.loginFoot}>Your data stays on your own Baby Buddy server.</div>
    </div>
  );
}
