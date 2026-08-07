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
 */
class DjiApplication : Application() {

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        // Requerido por el MSDK v5 antes de cualquier otra llamada al SDK
        com.cySdkyc.clx.Helper.install(this)
    }

    override fun onCreate() {
        super.onCreate()
        SDKManager.getInstance().init(this, object : SDKManagerCallback {
            override fun onRegisterSuccess() {
                Log.i(TAG, "SDK registrado correctamente")
            }

            override fun onRegisterFailure(error: IDJIError?) {
                Log.e(TAG, "Fallo el registro del SDK: $error")
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
