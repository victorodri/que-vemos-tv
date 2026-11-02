package es.quevemos.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Qué Vemos para Fire TV / Android TV: una WebView a pantalla completa que carga la web de Vercel.
 * Toda la app vive en la web, así que cada despliegue en Vercel llega a la tele sin reinstalar el APK.
 *
 * El mando: las flechas llegan a la web como ArrowUp/Down/Left/Right (la web gestiona el foco),
 * OK se traduce a Enter y Atrás retrocede en el historial de la web o cierra la app.
 */
public class MainActivity extends Activity {

    private WebView web;
    private boolean offline = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0B0D12"));
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + " QueVemosTV/" + BuildConfig.VERSION_NAME);

        final String appHost = Uri.parse(BuildConfig.APP_URL).getHost();

        web.setWebViewClient(new WebViewClient() {
            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                Uri uri = Uri.parse(url);
                if (appHost != null && appHost.equals(uri.getHost())) {
                    offline = false;
                    return false;
                }
                // Enlaces externos: al navegador del sistema, si lo hay.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                }
                return true;
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                // En Android 6+ solo llega aquí si falla la página principal (no imágenes sueltas).
                showOffline();
            }
        });

        if (savedInstanceState != null) {
            web.restoreState(savedInstanceState);
        } else {
            web.loadUrl(BuildConfig.APP_URL);
        }
        web.requestFocus();
    }

    private void showOffline() {
        offline = true;
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<style>body{margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;"
                + "gap:24px;background:#0B0D12;color:#F2F4F8;font-family:sans-serif;text-align:center}"
                + "h1{font-size:40px;margin:0}h1 span{color:#FFC83D}p{font-size:22px;color:#A3ACBD;margin:0}"
                + "a{font-size:24px;font-weight:bold;padding:14px 32px;border-radius:14px;background:#FFC83D;color:#1A1400;text-decoration:none}"
                + "a:focus{outline:4px solid #fff}</style></head><body>"
                + "<h1>Qué <span>Vemos</span></h1><p>No hay conexión a internet.</p>"
                + "<a id='r' href='" + BuildConfig.APP_URL + "'>Reintentar</a>"
                + "<script>document.getElementById('r').focus()</script></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // El botón central del mando como Enter, para que «pulse» el botón enfocado en la web.
        if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_CENTER) {
            return super.dispatchKeyEvent(new KeyEvent(event.getDownTime(), event.getEventTime(), event.getAction(),
                    KeyEvent.KEYCODE_ENTER, event.getRepeatCount(), event.getMetaState()));
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (!offline && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        web.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }
}
