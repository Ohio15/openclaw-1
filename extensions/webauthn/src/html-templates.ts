/**
 * Server-rendered HTML templates for WebAuthn flows.
 * All pages use a dark theme matching the PWA styles.
 */

function pageShell(title: string, rpName: string, body: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${escapeHtml(title)} - ${escapeHtml(rpName)}</title>
<style>
  body { background:#0d1117; color:#e6edf3; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; margin:0; padding:0; min-height:100dvh; display:flex; align-items:center; justify-content:center; }
  a { color:#58a6ff; text-decoration:none; }
  button { -webkit-tap-highlight-color:transparent; }
  input { outline:none; }
  input:focus { border-color:#58a6ff !important; }
</style>
</head><body>${body}</body></html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Shared base64url helper JS used by both registration and approval pages
const BASE64URL_HELPERS = `
function base64urlToBuffer(b64) {
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - b64.length % 4);
  const base64 = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  return Uint8Array.from(binary, c => c.charCodeAt(0)).buffer;
}

function bufferToBase64url(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  bytes.forEach(b => binary += String.fromCharCode(b));
  return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
}`;

export function registrationPage(setupToken: string, rpName: string, credentialCount: number): string {
  const hasExisting = credentialCount > 0;
  const existingNote = hasExisting
    ? `<br><span style="color:#3fb950">${credentialCount} passkey(s) registered</span>`
    : "";

  return pageShell("Register Device", rpName, `
    <div style="text-align:center;padding:20px;max-width:400px;margin:0 auto">
      <div style="font-size:48px;margin-bottom:12px">&#x1f511;</div>
      <h2 style="color:#58a6ff;margin-bottom:8px">Register Your Phone</h2>
      <p style="color:#8b949e;font-size:14px;margin-bottom:24px">
        Create a passkey to authorize new devices with Face ID / fingerprint.
        ${existingNote}
      </p>
      <input id="device-name" type="text" placeholder="Name this device (e.g. iPhone)"
        value="Phone" style="background:#161b22;border:1px solid #30363d;border-radius:8px;
        padding:10px 14px;color:#e6edf3;font-size:14px;width:220px;margin-bottom:16px;text-align:center">
      <br>
      <button onclick="startRegistration()" id="reg-btn"
        style="background:#1f6feb;color:white;border:none;border-radius:12px;
        padding:14px 40px;font-size:16px;cursor:pointer">
        Register Passkey
      </button>
      <div id="status" style="margin-top:20px;font-size:14px"></div>
    </div>
    <script>
      const setupToken = '${escapeHtml(setupToken)}';
      ${BASE64URL_HELPERS}

      async function startRegistration() {
        const name = document.getElementById('device-name').value || 'Phone';
        document.getElementById('reg-btn').textContent = 'Setting up...';
        document.getElementById('reg-btn').disabled = true;

        try {
          const optRes = await fetch('/auth/passkey/register/options', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({name, setup_token: setupToken})
          });
          if (!optRes.ok) {
            const err = await optRes.json();
            throw new Error(err.error || 'Failed to get registration options');
          }
          const options = await optRes.json();

          options.challenge = base64urlToBuffer(options.challenge);
          options.user.id = base64urlToBuffer(options.user.id);
          if (options.excludeCredentials) {
            options.excludeCredentials = options.excludeCredentials.map(c => ({
              ...c, id: base64urlToBuffer(c.id)
            }));
          }

          const credential = await navigator.credentials.create({ publicKey: options });

          const verifyRes = await fetch('/auth/passkey/register/verify', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
              name,
              setup_token: setupToken,
              id: credential.id,
              rawId: bufferToBase64url(credential.rawId),
              type: credential.type,
              response: {
                attestationObject: bufferToBase64url(credential.response.attestationObject),
                clientDataJSON: bufferToBase64url(credential.response.clientDataJSON),
              }
            })
          });

          const result = await verifyRes.json();
          if (result.success) {
            document.getElementById('status').innerHTML = '<span style="color:#3fb950;font-size:18px">Passkey registered!</span><p style="color:#8b949e;font-size:13px;margin-top:8px">You can now approve new devices by scanning QR codes.</p>';
            document.getElementById('reg-btn').style.display = 'none';
          } else {
            throw new Error(result.error || 'Registration failed');
          }
        } catch (e) {
          document.getElementById('status').innerHTML = '<span style="color:#f85149">'+e.message+'</span>';
          document.getElementById('reg-btn').textContent = 'Try Again';
          document.getElementById('reg-btn').disabled = false;
        }
      }
    </script>
  `);
}

export function registrationClosedPage(rpName: string): string {
  return pageShell("Registration Closed", rpName, `
    <div style="text-align:center;padding:20px;max-width:400px;margin:0 auto">
      <div style="font-size:48px;margin-bottom:12px">&#x1f6ab;</div>
      <h2 style="color:#f85149;margin-bottom:8px">Registration Closed</h2>
      <p style="color:#8b949e;font-size:14px">
        No setup token is active. Registration is closed.
        An admin must generate a new setup token to register additional passkeys.
      </p>
    </div>
  `);
}

export function invalidTokenPage(rpName: string): string {
  return pageShell("Invalid Token", rpName, `
    <div style="text-align:center;padding:20px;max-width:400px;margin:0 auto">
      <div style="font-size:48px;margin-bottom:12px">&#x1f512;</div>
      <h2 style="color:#f85149;margin-bottom:8px">Invalid Setup Token</h2>
      <p style="color:#8b949e;font-size:14px">
        A valid setup token is required to register a passkey.
        Check the server console output for the token.
      </p>
    </div>
  `);
}

export function qrApprovalPage(
  code: string,
  sig: string,
  deviceName: string,
  rpName: string,
  remainingSeconds: number,
  hasPasskey: boolean,
): string {
  return pageShell("Authorize", rpName, `
    <div style="text-align:center;padding:20px;max-width:400px;margin:0 auto">
      <div style="font-size:48px;margin-bottom:8px">${hasPasskey ? "&#x1f510;" : "&#x1f511;"}</div>
      <h2 style="color:#58a6ff;margin-bottom:16px">Authorize Device</h2>
      <div style="background:#21262d;border-radius:12px;padding:16px;margin:12px 0">
        <div style="font-size:28px;font-weight:700;letter-spacing:4px;color:#e6edf3">${escapeHtml(code)}</div>
        <div style="color:#8b949e;margin-top:6px;font-size:14px">${escapeHtml(deviceName)}</div>
        <div style="color:#484f58;font-size:11px;margin-top:4px">${remainingSeconds}s remaining</div>
      </div>

      ${hasPasskey
        ? '<p style="color:#8b949e;font-size:13px;margin-bottom:16px">Verify with your fingerprint or Face ID</p>'
        : '<p style="color:#8b949e;font-size:13px;margin-bottom:16px">Tap to approve this device</p>'}

      <button onclick="approve()" id="approve-btn"
        style="background:#1f6feb;color:white;border:none;border-radius:12px;
        padding:16px 48px;font-size:18px;cursor:pointer;width:100%;max-width:280px">
        ${hasPasskey ? "Verify &amp; Approve" : "Approve"}
      </button>

      <div id="status" style="margin-top:20px;font-size:15px"></div>

      ${!hasPasskey ? '<p style="color:#484f58;font-size:11px;margin-top:24px"><a href="/auth/register">Register a passkey</a> for biometric approval</p>' : ""}
    </div>
    <script>
      const usePasskey = ${hasPasskey};
      const code = '${escapeHtml(code)}';
      const sig = '${escapeHtml(sig)}';
      ${BASE64URL_HELPERS}

      async function approve() {
        const btn = document.getElementById('approve-btn');
        btn.disabled = true;
        btn.textContent = 'Verifying...';

        try {
          if (usePasskey) {
            await passkeyApprove();
          } else {
            await hmacApprove();
          }
        } catch(e) {
          document.getElementById('status').innerHTML = '<span style="color:#f85149">'+e.message+'</span>';
          btn.textContent = 'Try Again';
          btn.disabled = false;
        }
      }

      async function passkeyApprove() {
        const optRes = await fetch('/auth/passkey/auth/options', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({code})
        });
        const options = await optRes.json();

        options.challenge = base64urlToBuffer(options.challenge);
        if (options.allowCredentials) {
          options.allowCredentials = options.allowCredentials.map(c => ({
            ...c, id: base64urlToBuffer(c.id)
          }));
        }

        const assertion = await navigator.credentials.get({ publicKey: options });

        const verifyRes = await fetch('/auth/passkey/auth/verify', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({
            code,
            id: assertion.id,
            rawId: bufferToBase64url(assertion.rawId),
            type: assertion.type,
            response: {
              authenticatorData: bufferToBase64url(assertion.response.authenticatorData),
              clientDataJSON: bufferToBase64url(assertion.response.clientDataJSON),
              signature: bufferToBase64url(assertion.response.signature),
              userHandle: assertion.response.userHandle ? bufferToBase64url(assertion.response.userHandle) : null,
            }
          })
        });

        const result = await verifyRes.json();
        if (result.success) {
          showSuccess(result.device);
        } else {
          throw new Error(result.error || 'Verification failed');
        }
      }

      async function hmacApprove() {
        const res = await fetch('/auth/qr/' + code + '/' + sig + '/confirm', {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({action:'approve'})
        });
        if (res.ok) {
          const data = await res.json();
          showSuccess(data.device);
        } else {
          throw new Error('Approval failed');
        }
      }

      function showSuccess(deviceName) {
        document.getElementById('approve-btn').style.display = 'none';
        document.getElementById('status').innerHTML = '<div style="color:#3fb950;font-size:18px;font-weight:600">Approved</div><p style="color:#8b949e;font-size:13px;margin-top:8px">' + (deviceName || 'Device') + ' can now connect.</p>';
        if (navigator.vibrate) navigator.vibrate(100);
      }
    </script>
  `);
}

export function simplePage(rpName: string, title: string, body: string): string {
  return pageShell(title, rpName, body);
}
