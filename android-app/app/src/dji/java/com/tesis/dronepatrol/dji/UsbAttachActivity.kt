package com.tesis.dronepatrol.dji

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * La que Android abre al enchufar el control (USB_ACCESSORY_ATTACHED). No tiene
 * pantalla: trae la app al frente —la tarea que ya estaba, si la había, sin
 * reiniciar la operación— y se cierra. Es lo que hace el sample oficial, salvo
 * que acá no se limpia la pila: cerrar la pantalla de operación por enchufar el
 * cable sería dejar al dron sin la app en pleno vuelo.
 */
class UsbAttachActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        packageManager.getLaunchIntentForPackage(packageName)?.let { lanzador ->
            lanzador.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            startActivity(lanzador)
        }
        finish()
    }
}
