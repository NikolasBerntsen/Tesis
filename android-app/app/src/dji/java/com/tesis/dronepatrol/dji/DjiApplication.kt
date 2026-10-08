package com.tesis.dronepatrol.dji

import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import dji.v5.common.error.IDJIError
import dji.v5.common.register.DJISDKInitEvent
import dji.v5.manager.SDKManager
import dji.v5.manager.interfaces.SDKManagerCallback

/**
 * Inicialización del DJI Mobile SDK v5. La App Key se toma del manifest
 * (placeholder DJI_API_KEY, que build.gradle.kts carga desde local.properties).
 *
 * Toda la inicialización va envuelta en try/catch: el SDK carga librerías
 * nativas y se registra contra los servidores de DJI, y cualquiera de esas dos
 * cosas puede fallar (sin App Key, sin red, en un emulador x86). Si eso
 * ocurriera fuera de un try/catch, la app se cerraría al instante y sin UI,
 * porque pasa antes de que exista la Activity. Lo que pasa queda en [DjiSdk]
 * para que la pantalla de operación lo muestre con todas las letras.
 */
class DjiApplication : Application() {

    override fun attachBaseContext(base: Context) {
        super.attachBaseContext(base)
        // Requerido por el MSDK v5 antes de cualquier otra llamada al SDK (el
        // nombre de la clase cambió en 5.10: antes era com.secneo.sdk.Helper).
        runCatching { com.cySdkyc.clx.Helper.install(this) }
            .onFailure {
                Log.e(TAG, "No se pudo instalar el helper nativo del SDK", it)
                DjiSdk.actualizar { e -> e.copy(ultimoError = "no se pudo cargar el SDK de DJI en este teléfono (${it.message})") }
            }
    }

    override fun onCreate() {
        super.onCreate()

        val apiKey = runCatching {
            packageManager.getApplicationInfo(packageName, PackageManager.GET_META_DATA)
                .metaData?.getString("com.dji.sdk.API_KEY")
        }.getOrNull()

        if (apiKey.isNullOrBlank()) {
            Log.w(TAG, "Sin App Key de DJI: se omite el registro del SDK. Cargá DJI_API_KEY en local.properties.")
            DjiSdk.actualizar { it.copy(ultimoError = "la app se compiló sin App Key de DJI (DJI_API_KEY en local.properties)") }
            return
        }

        runCatching { initSdk() }
            .onFailure {
                Log.e(TAG, "Falló la inicialización del SDK de DJI", it)
                DjiSdk.actualizar { e -> e.copy(ultimoError = "falló la inicialización del SDK: ${it.message}") }
            }
    }

    private fun initSdk() {
        SDKManager.getInstance().init(this, object : SDKManagerCallback {
            override fun onRegisterSuccess() {
                Log.i(TAG, "SDK registrado correctamente")
                DjiSdk.actualizar { it.copy(registrado = true, ultimoError = "") }
            }

            override fun onRegisterFailure(error: IDJIError?) {
                Log.e(TAG, "Falló el registro del SDK: $error")
                // INVALID_METADATA es el caso típico: la App Key se generó para
                // otro package name. Se traduce porque es lo primero que se va a
                // ver en el campo si la clave está mal.
                val motivo = error?.description().orEmpty().ifBlank { error?.errorCode().orEmpty() }
                DjiSdk.actualizar {
                    it.copy(
                        registrado = false,
                        ultimoError = "DJI rechazó el registro de la app ($motivo). Revisá que la App Key sea " +
                            "de una app con package com.tesis.dronepatrol y que el teléfono tenga internet.",
                    )
                }
            }

            override fun onProductConnect(productId: Int) {
                Log.i(TAG, "Dron conectado (productId=$productId)")
                DjiSdk.actualizar { it.copy(productoConectado = true, productId = productId) }
            }

            override fun onProductDisconnect(productId: Int) {
                Log.w(TAG, "Dron desconectado")
                DjiSdk.actualizar { it.copy(productoConectado = false, productId = 0) }
            }

            override fun onProductChanged(productId: Int) {
                DjiSdk.actualizar { it.copy(productId = productId) }
            }

            override fun onInitProcess(event: DJISDKInitEvent?, totalProcess: Int) {
                if (event == DJISDKInitEvent.INITIALIZE_COMPLETE) {
                    DjiSdk.actualizar { it.copy(inicializado = true) }
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
