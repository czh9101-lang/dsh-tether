import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// 签名配置。Tauri 生成的工程不带这段,而 release 版 APK 不签名就装不上。
// 密钥由 CI 从 secrets 落成 ../keystore.properties;本地没有该文件时不声明
// 签名配置,release 构建仍然可以跑(产出未签名包),不至于把本地开发卡死。
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "cc.zexa.dshtether"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "cc.zexa.dshtether"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            keystoreProperties["storeFile"]?.let { storeFile = file(it as String) }
            storePassword = keystoreProperties["storePassword"] as String?
            keyAlias = keystoreProperties["keyAlias"] as String?
            keyPassword = keystoreProperties["password"] as String?
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (keystoreProperties.containsKey("storeFile")) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    // 本地模式的运行时由 scripts/build-android-runtime.mjs 生成到 ../../../android-runtime/(不入 git):
    // node 可执行文件以 libnode.so 走 jniLibs(Android 10+ 只允许 exec APK 原生库目录里的文件),
    // 其余进 assets。没生成时目录不存在,gradle 照常构建,APK 里只是没有本地模式。
    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("../../../android-runtime/jniLibs")
            assets.srcDirs("../../../android-runtime/assets")
        }
    }
    packaging {
        // 让 libnode.so 落成真实文件而不是留在 APK 里按需 mmap:exec 需要一个路径
        jniLibs.useLegacyPackaging = true
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")