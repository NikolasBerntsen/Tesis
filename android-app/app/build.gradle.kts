import java.util.Properties
import org.gradle.testing.jacoco.plugins.JacocoTaskExtension

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/**
 * App Key del MSDK de DJI. Se busca, en este orden, en `local.properties`
 * (que git ignora: es el lugar para una clave), en la variable de entorno
 * `DJI_API_KEY` y en una propiedad de Gradle (`-PDJI_API_KEY=...`). Nunca va en
 * `gradle.properties` del repo: la clave está atada al `applicationId` y a la
 * cuenta de desarrollador de quien la generó.
 */
val djiApiKey: String = run {
    val local = Properties()
    val archivo = rootProject.file("local.properties")
    if (archivo.exists()) archivo.inputStream().use { local.load(it) }
    local.getProperty("DJI_API_KEY")?.trim().orEmpty()
        .ifEmpty { System.getenv("DJI_API_KEY")?.trim().orEmpty() }
        .ifEmpty { (project.findProperty("DJI_API_KEY") as String?)?.trim().orEmpty() }
}

android {
    namespace = "com.tesis.dronepatrol"
    // 35: la configuración sugerida por DJI para el MSDK desde 5.17 ("Android
    // API upgraded to 35"); el sample oficial compila y apunta a 35.
    compileSdk = 35

    defaultConfig {
        applicationId = "com.tesis.dronepatrol"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"
    }

    // mock: dron simulado, corre en cualquier dispositivo/emulador sin hardware.
    // dji : integración real con DJI MSDK v5 (requiere App Key y un teléfono
    //       ARM enganchado a un RC-N2/RC-N3 con el Mini 4 Pro).
    flavorDimensions += "drone"
    productFlavors {
        create("mock") { dimension = "drone" }
        create("dji") {
            dimension = "drone"
            manifestPlaceholders["DJI_API_KEY"] = djiApiKey
            // El MSDK v5 publica sus librerías nativas solo para arm64-v8a: un
            // APK con otros ABI adentro no sirve de nada y pesa el doble.
            ndk { abiFilters += listOf("arm64-v8a") }
        }
    }

    buildTypes {
        getByName("debug") {
            // Instrumenta con JaCoCo los tests unitarios (los de Robolectric
            // incluidos) para que AGP genere el informe de cobertura que lee
            // SonarQube. Va solo en debug: el APK de release no se instrumenta.
            enableUnitTestCoverage = true
        }
        getByName("release") {
            // No hay un keystore propio del proyecto: sin firma el APK de release
            // no se puede instalar en ningún teléfono. Se firma con el keystore
            // de debug de la máquina, que alcanza para las salidas de campo (no
            // para publicar en una tienda).
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures { viewBinding = true }

    // Robolectric corre los tests contra el framework de Android en la JVM
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            // Robolectric carga las clases con su propio classloader y las deja
            // sin "location"; JaCoCo, por defecto, esas las ignora. Sin esta
            // línea la cobertura de todo lo que solo se prueba con Robolectric
            // —PatrolManager entero, por ejemplo— se informa como CERO, sin un
            // solo error que lo delate: el tablero de Sonar muestra un 0 % que
            // no es cierto. `jdk.internal.*` se excluye porque instrumentarlo
            // rompe el arranque de la JVM.
            all {
                it.extensions.configure(JacocoTaskExtension::class.java) {
                    isIncludeNoLocationClasses = true
                    excludes = listOf("jdk.internal.*")
                }
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging {
        // El MSDK de DJI trae librerías nativas que pueden duplicar estos archivos
        resources.pickFirsts += listOf("META-INF/rxjava.properties")
        jniLibs {
            // El SDK requiere extraer sus librerías nativas al instalar
            // (android:extractNativeLibs="true" en el manifest del flavor).
            useLegacyPackaging = true
            // Y que NO se les quite el símbolo: es la lista `doNotStrip` del
            // sample oficial del MSDK v5. Sin esto, algunas se cargan mal y el
            // SDK falla al registrar sin un error que lo explique.
            keepDebugSymbols += listOf(
                "libconstants.so", "libdji_innertools.so", "libdjibase.so", "libDJICSDKCommon.so",
                "libDJIFlySafeCore-CSDK.so", "libdjifs_jni-CSDK.so", "libDJIRegister.so", "libdjisdk_jni.so",
                "libDJIUpgradeCore.so", "libDJIUpgradeJNI.so", "libDJIWaypointV2Core-CSDK.so", "libdjiwpv2-CSDK.so",
                "libFlightRecordEngine.so", "libvideo-framing.so", "libwaes.so", "libagora-rtsa-sdk.so",
                "libc++.so", "libc++_shared.so", "libmrtc_28181.so", "libmrtc_agora.so", "libmrtc_core.so",
                "libmrtc_core_jni.so", "libmrtc_data.so", "libmrtc_log.so", "libmrtc_onvif.so", "libmrtc_rtmp.so",
                "libmrtc_rtsp.so",
            ).map { "**/$it" }
            pickFirsts += listOf("**/libc++_shared.so")
        }
    }
}

// El flavor dji queda deshabilitado salvo que haya App Key cargada o se pida
// explícitamente. Sin esto, Android Studio ofrece "djiDebug" como variante por
// defecto (ordena antes que "mockDebug") y al correrla en un emulador la app se
// cierra al instante: el SDK de DJI se inicializa en la clase Application y no
// puede registrarse sin App Key ni hardware. Para compilarlo:
//   ./gradlew assembleDjiDebug -PenableDji     (o con DJI_API_KEY en local.properties)
androidComponents {
    beforeVariants(selector().withFlavor("drone" to "dji")) { variant ->
        variant.enable = project.hasProperty("enableDji") || djiApiKey.isNotEmpty()
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("com.google.android.material:material:1.12.0")
    // El visor de video de la pantalla de operación se dimensiona por relación de aspecto
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Escaneo del QR del dron: trae su propia Activity de cámara, sin CameraX
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // Instantánea GPS del despliegue, para el registro del emparejamiento
    implementation("com.google.android.gms:play-services-location:21.3.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("androidx.test:core:1.6.1")

    // DJI Mobile SDK v5 — solo para el flavor "dji" (publicado en Maven Central).
    // 5.17.0 es la primera versión con el Mini 4 Pro + RC-N3; 5.18.0 (mayo 2026)
    // es la vigente. Las misiones de waypoints nativas NO están para el Mini 4
    // Pro (solo Enterprise), por eso el patrullaje usa Virtual Stick.
    val msdk = "5.18.0"
    "djiImplementation"("com.dji:dji-sdk-v5-aircraft:$msdk")
    "djiCompileOnly"("com.dji:dji-sdk-v5-aircraft-provided:$msdk")
    "djiRuntimeOnly"("com.dji:dji-sdk-v5-networkImp:$msdk")
}
