plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.tesis.dronepatrol"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.tesis.dronepatrol"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    // mock: dron simulado, corre en cualquier dispositivo/emulador sin hardware.
    // dji : integración real con DJI MSDK v5 (requiere API key y un dispositivo real).
    flavorDimensions += "drone"
    productFlavors {
        create("mock") { dimension = "drone" }
        create("dji") {
            dimension = "drone"
            manifestPlaceholders["DJI_API_KEY"] = (project.findProperty("DJI_API_KEY") ?: "") as String
        }
    }

    buildFeatures { viewBinding = true }

    // Robolectric corre los tests contra el framework de Android en la JVM
    testOptions { unitTests { isIncludeAndroidResources = true } }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging {
        // El MSDK de DJI trae librerías nativas que pueden duplicar estos archivos
        resources.pickFirsts += listOf("META-INF/rxjava.properties")
        // El SDK requiere extraer sus librerías nativas al instalar
        jniLibs.useLegacyPackaging = true
    }
}

// El flavor dji queda deshabilitado salvo que se pida explícitamente. Sin esto,
// Android Studio ofrece "djiDebug" como variante por defecto (ordena antes que
// "mockDebug") y al correrla en un emulador la app se cierra al instante: el SDK
// de DJI se inicializa en la clase Application y no puede registrarse sin API key
// ni hardware. Para compilarlo: ./gradlew assembleDjiDebug -PenableDji
androidComponents {
    beforeVariants(selector().withFlavor("drone" to "dji")) { variant ->
        variant.enable = project.hasProperty("enableDji")
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.13")
    testImplementation("androidx.test:core:1.6.1")

    // DJI Mobile SDK v5 — solo para el flavor "dji" (publicado en Maven Central).
    // Nota: el Mini 4 Pro está soportado por MSDK v5; las misiones de waypoints
    // nativas NO (solo Enterprise), por eso el patrullaje usa Virtual Stick.
    "djiImplementation"("com.dji:dji-sdk-v5-aircraft:5.15.0")
    "djiCompileOnly"("com.dji:dji-sdk-v5-aircraft-provided:5.15.0")
    "djiRuntimeOnly"("com.dji:dji-sdk-v5-networkImp:5.15.0")
}
