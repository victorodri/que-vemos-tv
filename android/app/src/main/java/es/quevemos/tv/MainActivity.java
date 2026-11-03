package es.quevemos.tv;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * QuéVer para Fire TV / Android TV: una WebView a pantalla completa que carga la web de Vercel.
 * Toda la app vive en la web, así que cada despliegue en Vercel llega a la tele sin reinstalar el APK.
 *
 * El mando: las flechas llegan a la web como ArrowUp/Down/Left/Right (la web gestiona el foco),
 * OK se traduce a Enter (sobre un campo de texto, en cambio, abre el teclado en pantalla) y Atrás se delega en la web (window.__queVemosBack): la web decide si cierra una ficha,
 * vuelve a «Para ti» o, con una segunda pulsación, cierra la app llamando a QueVemosAndroid.exit().
 * Si la web no responde (página sin cargar o versión antigua), se retrocede en el historial o se cierra la app.
 */
public class MainActivity extends Activity {

    private WebView web;
    private boolean offline = false;
    // OK del mando pendiente de saber si el foco está en un campo de texto (ver handleCenter).
    private KeyEvent centerDown = null;
    private boolean centerAnswered = false;
    private boolean centerUpPending = false;
    private boolean centerIsText = false;

    /** Puente que ve la web como window.QueVemosAndroid. Solo expone cerrar la app. */
    public final class Bridge {
        @JavascriptInterface
        public void exit() {
            // Las llamadas de JavaScript llegan en un hilo del WebView: finish() tiene que ir al hilo principal.
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    finish();
                }
            });
        }
    }

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
        // Los sonidos de la interfaz (Web Audio) no deben esperar a un gesto «de vídeo».
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "QueVemosAndroid");

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
                + "<h1>Qué<span>Ver</span></h1><p>No hay conexión a internet.</p>"
                + "<a id='r' href='" + BuildConfig.APP_URL + "'>Reintentar</a>"
                + "<script>document.getElementById('r').focus()</script></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Atrás: se consume aquí (pulsar y soltar) y se delega en la web al soltar, una sola vez por pulsación.
        // Así la web no recibe además una tecla Escape/GoBack ni el WebView retrocede por su cuenta.
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (event.getAction() == KeyEvent.ACTION_UP && !event.isCanceled()) handleBack();
            return true;
        }
        if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_CENTER && !offline) {
            handleCenter(event);
            return true;
        }
        // El botón central del mando como Enter, para que «pulse» el botón enfocado en la web.
        if (event.getKeyCode() == KeyEvent.KEYCODE_DPAD_CENTER) {
            return super.dispatchKeyEvent(asEnter(event));
        }
        return super.dispatchKeyEvent(event);
    }

    private static KeyEvent asEnter(KeyEvent e) {
        return new KeyEvent(e.getDownTime(), e.getEventTime(), e.getAction(), KeyEvent.KEYCODE_ENTER, e.getRepeatCount(), e.getMetaState());
    }

    /**
     * OK del mando. Si el foco de la web está en un campo de texto, abre el teclado en pantalla (el WebView no lo abre
     * solo con Enter, y Enter enviaría el formulario vacío). Si no, se reenvía como Enter. Como saber qué hay enfocado
     * es asíncrono, la pulsación se guarda hasta tener la respuesta; si el «soltar» llega antes, se envía después.
     */
    private void handleCenter(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            if (event.getRepeatCount() > 0 || centerDown != null) return;
            final KeyEvent down = event;
            centerDown = down;
            centerAnswered = false;
            centerUpPending = false;
            web.evaluateJavascript(
                    "(function(){var e=document.activeElement;if(!e)return false;var t=(e.type||'').toLowerCase();"
                            + "return e.tagName==='TEXTAREA'||e.isContentEditable||(e.tagName==='INPUT'&&['text','search','email','url','tel','number','password',''].indexOf(t)>=0);})()",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            if (centerDown != down) return;
                            centerAnswered = true;
                            centerIsText = "true".equals(value);
                            if (centerIsText) showKeyboard();
                            else web.dispatchKeyEvent(asEnter(down));
                            if (centerUpPending) finishCenter(KeyEvent.changeAction(down, KeyEvent.ACTION_UP));
                        }
                    });
        } else if (event.getAction() == KeyEvent.ACTION_UP && centerDown != null) {
            // Si la web aún no ha respondido, se suelta cuando responda.
            if (centerAnswered) finishCenter(event);
            else centerUpPending = true;
        }
    }

    private void finishCenter(KeyEvent up) {
        if (!centerIsText) web.dispatchKeyEvent(asEnter(up));
        centerDown = null;
        centerUpPending = false;
    }

    private void showKeyboard() {
        web.requestFocus();
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) imm.showSoftInput(web, InputMethodManager.SHOW_FORCED);
    }

    /** Pregunta a la web si gestiona Atrás; si no (sin cargar, sin conexión, versión antigua), comportamiento clásico. */
    private void handleBack() {
        if (offline) {
            fallbackBack();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return !!(window.__queVemosBack&&window.__queVemosBack());}catch(e){return false;}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"true".equals(value)) fallbackBack();
                    }
                });
    }

    private void fallbackBack() {
        if (!offline && web.canGoBack()) {
            web.goBack();
        } else {
            finish();
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Normalmente no llega aquí (dispatchKeyEvent consume Atrás), pero por si algún dispositivo lo envía distinto.
        handleBack();
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
