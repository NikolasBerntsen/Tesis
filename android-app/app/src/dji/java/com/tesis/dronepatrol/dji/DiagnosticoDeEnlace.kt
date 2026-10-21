package com.tesis.dronepatrol.dji

import android.util.Log
import dji.sdk.keyvalue.key.DJIKeyInfo
import dji.sdk.keyvalue.key.FlightControllerKey
import dji.sdk.keyvalue.key.KeyTools
import dji.sdk.keyvalue.key.ProductKey
import dji.sdk.keyvalue.key.RemoteControllerKey
import dji.v5.manager.KeyManager

/**
 * Traza en el logcat las llaves que distinguen "el USB del control está abierto"
 * de "los datos del control y de la aeronave están llegando". Es solo
 * diagnóstico de campo: no cambia nada del vuelo. Se lee con
 * `adb logcat -s DiagnosticoDeEnlace`.
 *
 * Qué significa cada una:
 * - RC KeyConnection / KeyFirmwareVersion / KeySerialNumber: si llegan, el canal
 *   de datos con el control funciona (no solo el `openAccessory`).
 * - RC KeyIsStillLinked / KeyPairingStatus: si el control tiene enlace de radio
 *   con una aeronave.
 * - Product KeyConnection / KeyProductType / KeyInternalProductType /
 *   KeyDataLinkType: qué cree el SDK que hay del otro lado.
 * - Product KeyUnsupportedProductConnected / KeyNotSupportAppInfo: el SDK vio
 *   un producto que esta versión no soporta.
 * - FC KeyConnection / KeyFirmwareVersion: la aeronave propiamente dicha.
 */
internal object DiagnosticoDeEnlace {

    private const val TAG = "DiagnosticoDeEnlace"

    fun registrar(holder: Any) {
        trazar("RC KeyConnection", RemoteControllerKey.KeyConnection, holder)
        trazar("RC KeyFirmwareVersion", RemoteControllerKey.KeyFirmwareVersion, holder)
        trazar("RC KeySerialNumber", RemoteControllerKey.KeySerialNumber, holder)
        trazar("RC KeyRCUSBMode", RemoteControllerKey.KeyRCUSBMode, holder)
        trazar("RC KeyIsStillLinked", RemoteControllerKey.KeyIsStillLinked, holder)
        trazar("RC KeyPairingStatus", RemoteControllerKey.KeyPairingStatus, holder)
        trazar("RC KeyUsbDeviceAttached", RemoteControllerKey.KeyUsbDeviceAttached, holder)
        trazar("Product KeyConnection", ProductKey.KeyConnection, holder)
        trazar("Product KeyProductType", ProductKey.KeyProductType, holder)
        trazar("Product KeyInternalProductType", ProductKey.KeyInternalProductType, holder)
        trazar("Product KeyDataLinkType", ProductKey.KeyDataLinkType, holder)
        trazar("Product KeyFirmwareVersion", ProductKey.KeyFirmwareVersion, holder)
        trazar("Product KeyUnsupportedProductConnected", ProductKey.KeyUnsupportedProductConnected, holder)
        trazar("Product KeyNotSupportAppInfo", ProductKey.KeyNotSupportAppInfo, holder)
        trazar("FC KeyConnection", FlightControllerKey.KeyConnection, holder)
        trazar("FC KeyFirmwareVersion", FlightControllerKey.KeyFirmwareVersion, holder)
        // GPS: para distinguir "la app no lee los satélites" de "el dron no los
        // ve" (interior, ventana, arranque en frío).
        trazar("FC KeyGPSSatelliteCount", FlightControllerKey.KeyGPSSatelliteCount, holder)
        trazar("FC KeyGPSSignalLevel", FlightControllerKey.KeyGPSSignalLevel, holder)
        trazar("FC KeyGPSIsValid", FlightControllerKey.KeyGPSIsValid, holder)
        trazar("FC KeyFCGPSEnabled", FlightControllerKey.KeyFCGPSEnabled, holder)
        trazar("FC KeyGPSModeFailureReason", FlightControllerKey.KeyGPSModeFailureReason, holder)
        trazar("FC KeyGPSInterferenceState", FlightControllerKey.KeyGPSInterferenceState, holder)
        trazar("FC KeyIsHomeLocationSet", FlightControllerKey.KeyIsHomeLocationSet, holder)
        trazar("FC KeyFlightModeString", FlightControllerKey.KeyFlightModeString, holder)
        trazar("FC KeyPositioningDataSource", FlightControllerKey.KeyPositioningDataSource, holder)
        // La posición cambia diez veces por segundo en vuelo: solo el valor en caché.
        trazar("FC KeyAircraftLocation3D", FlightControllerKey.KeyAircraftLocation3D, holder, escuchar = false)
        trazar("FC KeyIsVisionSensorUsed", FlightControllerKey.KeyIsVisionSensorUsed, holder)
    }

    private fun <T> trazar(nombre: String, llave: DJIKeyInfo<T>, holder: Any, escuchar: Boolean = true) {
        runCatching {
            val km = KeyManager.getInstance()
            val key = KeyTools.createKey(llave)
            Log.i(TAG, "$nombre (caché) = ${km.getValue(key) ?: "sin valor"}")
            if (escuchar) km.listen(key, holder) { viejo, nuevo -> Log.i(TAG, "$nombre: $viejo -> $nuevo") }
        }.onFailure { Log.w(TAG, "$nombre: no se pudo leer (${it.message})") }
    }
}
