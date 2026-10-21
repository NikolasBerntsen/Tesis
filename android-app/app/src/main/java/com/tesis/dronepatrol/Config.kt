package com.tesis.dronepatrol

import android.content.Context
import androidx.core.content.edit
import com.tesis.dronepatrol.comms.ModoEnlace

/** Direcciones y puertos del sistema, en un solo lugar para no repetirlos. */
object Config {

    /** Comando Central de producción; el operador puede editarlo en el login. */
    const val URL_COMANDO_CENTRAL_POR_DEFECTO = "https://tesis.144-22-138-149.sslip.io"

    const val PUERTO_DETECCION = 8765

    /**
     * Puerto UDP por el que la laptop anuncia su servicio de detección a toda la
     * red (ver [com.tesis.dronepatrol.comms.DescubridorDeDeteccion]).
     */
    const val PUERTO_ANUNCIO_DETECCION = 8766

    /** Nombre con el que se anuncia: cualquier otro datagrama en ese puerto se ignora. */
    const val SERVICIO_DETECCION = "dronepatrol-detection"

    /**
     * En modo CABLE la detección queda en el localhost del celular: el túnel lo
     * arma la laptop con 'adb reverse tcp:8765 tcp:8765' sobre el cable USB. Con
     * el control enchufado el puerto está ocupado, así que en el campo el modo es
     * AUTO; CABLE sirve en el banco de pruebas y en el emulador.
     */
    const val URL_DETECCION_CABLE = "ws://127.0.0.1:$PUERTO_DETECCION/phone"

    /** Ejemplo para el modo RED, donde la URL la escribe el operador. */
    const val PLANTILLA_URL_DETECCION_RED = "ws://<ip-de-la-laptop>:$PUERTO_DETECCION"

    /**
     * Desde el emulador de Android Studio, la PC donde corre el emulador es
     * siempre esta dirección: sirve para apuntar la detección (modo RED) a la
     * laptop sin tipear nada.
     */
    const val URL_DETECCION_EMULADOR = "ws://10.0.2.2:$PUERTO_DETECCION"
}

/**
 * Configuración del enlace que sobrevive a los reinicios. En el campo la app se
 * reabre seguido y nadie quiere retipear la URL del Comando Central con los
 * guantes puestos.
 */
class PreferenciasEnlace(context: Context) {

    private val prefs = context.applicationContext.getSharedPreferences(ARCHIVO, Context.MODE_PRIVATE)

    var urlComandoCentral: String
        get() = prefs.getString(CLAVE_URL_COMANDO_CENTRAL, null)?.trim().orEmpty()
            .ifEmpty { Config.URL_COMANDO_CENTRAL_POR_DEFECTO }
        set(valor) = prefs.edit { putString(CLAVE_URL_COMANDO_CENTRAL, valor.trim()) }

    /** De fábrica, AUTO: la laptop se descubre sola en la red Wi-Fi. */
    var modoEnlace: ModoEnlace
        get() = runCatching { ModoEnlace.valueOf(prefs.getString(CLAVE_MODO_ENLACE, "").orEmpty()) }
            .getOrDefault(ModoEnlace.AUTO)
        set(valor) = prefs.edit { putString(CLAVE_MODO_ENLACE, valor.name) }

    /** Solo cuenta en modo RED: en CABLE la URL es fija y en AUTO la anuncia la laptop. */
    var urlDeteccionRed: String
        get() = prefs.getString(CLAVE_URL_DETECCION_RED, "").orEmpty()
        set(valor) = prefs.edit { putString(CLAVE_URL_DETECCION_RED, valor.trim()) }

    private companion object {
        const val ARCHIVO = "enlace"
        const val CLAVE_URL_COMANDO_CENTRAL = "urlComandoCentral"
        const val CLAVE_MODO_ENLACE = "modoEnlace"
        const val CLAVE_URL_DETECCION_RED = "urlDeteccionRed"
    }
}
