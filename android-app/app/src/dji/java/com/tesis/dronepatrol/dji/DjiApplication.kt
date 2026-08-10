package com.tesis.dronepatrol.dji

import android.app.Application
import android.content.Context
import android.util.Log
import dji.v5.common.error.IDJIError
import dji.v5.common.register.DJISDKInitEvent
import dji.v5.manager.SDKManager
import dji.v5.manager.interfaces.SDKManagerCallback

/**
 * Inicialización del DJI Mobile SDK v5. La API key se toma del manifest
 * (placeholder DJI_API_KEY definido en gradle.properties).
 *
 * Toda la inicialización va envuelta en try/catch: el SDK carga librerías
 * nativas y se registra contra los servidores de DJI, y cualquiera de esas dos
 * cosas puede fallar (sin API key, sin red, en un emulador). Si eso ocurriera
 * fuera de un try/catch, la app se cerraría al instante y sin UI, porque pasa
 * antes de que exista la Activity.
 */
class DjiApplication : Application() {

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        // Requerido por el MSDK v5 antes de cualquier otra llamada al SDK
        runCatching { com.cySdkyc.clx.Helper.install(this) }
            .onFailure { Log.e(TAG, "No se pudo instalar el helper nativo del SDK", it) }
    }

    override fun onCreate() {
        super.onCreate()

        val apiKey = runCatching {
            packageManager.getApplicationInfo(packageName, android.content.pm.PackageManager.GET_META_DATA)
                .metaData?.getString("com.dji.sdk.API_KEY")
        }.getOrNull()

        if (apiKey.isNullOrBlank()) {
            Log.w(TAG, "Sin API key de DJI: se omite el registro del SDK. " +
                "Cargá DJI_API_KEY en gradle.properties para volar con el dron.")
            return
        }

        runCatching { initSdk() }
            .onFailure { Log.e(TAG, "Falló la inicialización del SDK de DJI", it) }
    }

    private fun initSdk() {
        SDKManager.getInstance().init(this, object : SDKManagerCallback {
            override fun onRegisterSuccess() {
                Log.i(TAG, "SDK registrado correctamente")
            }

            override fun onRegisterFailure(error: IDJIError?) {
                Log.e(TAG, "Falló el registro del SDK: $error")
            }

            override fun onProductConnect(productId: Int) {
                Log.i(TAG, "Dron conectado (productId=$productId)")
            }

            override fun onProductDisconnect(productId: Int) {
                Log.w(TAG, "Dron desconectado")
            }

            override fun onProductChanged(productId: Int) = Unit

            override fun onInitProcess(event: DJISDKInitEvent?, totalProcess: Int) {
                if (event == DJISDKInitEvent.INITIALIZE_COMPLETE) {
                    SDKManager.getInstance().registerApp()
                }
            }

            override fun onDatabaseDownloadProgress(current: Long, total: Long) = Unit
        })
    }

    private companion object {
        const val TAG = "DjiApplication"
    }
}
