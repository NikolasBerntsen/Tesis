package com.tesis.dronepatrol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * El hash del QR es lo único que el operador de campo manda a emparejar: si el
 * filtro afloja, cualquier código que se cruce en el campo termina golpeando el
 * Comando Central. Corre en la JVM pelada porque no toca nada de Android.
 */
class HashDeDronTest {

    private companion object {
        const val HASH = "0123456789abcdef0123456789abcdef"
    }

    @Test
    fun aceptaLos32HexDelStickerDelDron() {
        assertEquals(HASH, hashDeDronODescartar(HASH))
    }

    @Test
    fun normalizaLoQueDevuelveElEscaner() {
        // El lector suele traer el contenido con espacios o salto de línea al final
        assertEquals(HASH, hashDeDronODescartar("  ${HASH.uppercase()}\n"))
    }

    @Test
    fun rechazaTodoLoQueNoSeaUnHashDeDron() {
        listOf(
            "",
            "0123456789abcdef0123456789abcde", // 31: le falta uno
            "0123456789abcdef0123456789abcdef0", // 33: le sobra uno
            "0123456789abcdef0123456789abcdeg", // la 'g' no es hexadecimal
            "0123456789abcdef 123456789abcdef", // espacio en el medio
            "https://tesis.144-22-138-149.sslip.io",
            "WIFI:S:Base;T:WPA;P:12345678;;",
            "$HASH\n$HASH", // dos hashes pegados no son uno
        ).forEach { assertNull("tendría que rechazar '$it'", hashDeDronODescartar(it)) }
    }

    @Test
    fun elHashSeMuestraAbreviado() {
        assertEquals("012345…cdef", hashAbreviado(HASH))
    }

    @Test
    fun unIdentificadorCortoSeMuestraEntero() {
        assertEquals("alfa-1", hashAbreviado("alfa-1"))
    }
}
