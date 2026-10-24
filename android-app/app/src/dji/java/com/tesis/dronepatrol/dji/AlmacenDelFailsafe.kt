package com.tesis.dronepatrol.dji

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit
import com.tesis.dronepatrol.drone.AlmacenDeTexto

/**
 * Dónde queda, en el teléfono, el failsafe que el dron tenía antes de que la
 * app lo pusiera en "aterrizar" para un desvío o una emergencia (ver
 * [com.tesis.dronepatrol.drone.RecuerdoDelFailsafe]). Las preferencias y no la
 * memoria porque el controlador se descarta con la pantalla: si se cierra en
 * pleno desvío, el que se cree después tiene que poder devolvérselo al dron.
 *
 * Lo inicia [DjiApplication] antes de que exista ningún controlador; sin
 * iniciar (en una prueba, por ejemplo) no guarda nada y el recuerdo queda en
 * memoria, como antes.
 */
internal object AlmacenDelFailsafe : AlmacenDeTexto {

    private const val ARCHIVO = "dron"
    private const val CLAVE = "failsafeOriginal"

    @Volatile
    private var prefs: SharedPreferences? = null

    fun iniciar(context: Context) {
        prefs = context.applicationContext.getSharedPreferences(ARCHIVO, Context.MODE_PRIVATE)
    }

    override fun leer(): String? = prefs?.getString(CLAVE, null)

    override fun escribir(valor: String?) {
        prefs?.edit {
            if (valor == null) remove(CLAVE) else putString(CLAVE, valor)
        }
    }
}
