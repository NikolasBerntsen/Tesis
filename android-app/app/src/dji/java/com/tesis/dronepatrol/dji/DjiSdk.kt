package com.tesis.dronepatrol.dji

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/**
 * Estado del MSDK en el proceso: si se inicializó, si se registró contra DJI y
 * si hay un producto (control + dron) conectado. Lo escribe [DjiApplication]
 * desde los callbacks del SDK y lo lee [DjiDroneController] para armar el
 * estado que ve la pantalla. Es un objeto porque el SDK es uno por proceso.
 */
object DjiSdk {

    data class Estado(
        val inicializado: Boolean = false,
        val registrado: Boolean = false,
        val productoConectado: Boolean = false,
        /** Identificador del producto que informa el SDK al conectarse (0 si ninguno). */
        val productId: Int = 0,
        /** Último problema del SDK, redactado; vacío si no hubo. */
        val ultimoError: String = "",
    )

    val estado: StateFlow<Estado> get() = _estado
    private val _estado = MutableStateFlow(Estado())

    internal fun actualizar(cambio: (Estado) -> Estado) = _estado.update(cambio)
}
