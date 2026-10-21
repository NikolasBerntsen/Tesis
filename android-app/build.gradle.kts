plugins {
    id("com.android.application") version "8.5.2" apply false
    // 2.1: el MSDK v5 de DJI desde 5.17 está compilado con Kotlin 2.1 y su
    // metadata no la lee un compilador 1.9 ("incompatible version of Kotlin").
    id("org.jetbrains.kotlin.android") version "2.1.10" apply false
}
