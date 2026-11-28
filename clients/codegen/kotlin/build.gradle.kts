// openapi-generator's Kotlin generator with kotlinx.serialization — what lumenbox-android uses — builds the models
// and their serializer from docs/api/v1.openapi.json; the tests decode answers from a newer server with them.
plugins {
    kotlin("jvm") version "2.0.21"
    kotlin("plugin.serialization") version "2.0.21"
    id("org.openapi.generator") version "7.10.0"
}

repositories { mavenCentral() }

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    testImplementation(kotlin("test"))
}

kotlin { jvmToolchain(17) }

val generated = layout.buildDirectory.dir("generated/openapi")

openApiGenerate {
    generatorName.set("kotlin")
    inputSpec.set(rootProject.file("../../../docs/api/v1.openapi.json").absolutePath)
    outputDir.set(generated.get().asFile.absolutePath)
    packageName.set("com.lumenopen.lumenbox.generated")
    globalProperties.set(mapOf("models" to "", "modelDocs" to "false", "modelTests" to "false", "supportingFiles" to "Serializer.kt,OffsetDateTimeAdapter.kt,LocalDateAdapter.kt,LocalDateTimeAdapter.kt,UUIDAdapter.kt,BigDecimalAdapter.kt,BigIntegerAdapter.kt,URIAdapter.kt,URLAdapter.kt,AtomicBooleanAdapter.kt,AtomicIntegerAdapter.kt,AtomicLongAdapter.kt,StringBuilderAdapter.kt"))
    additionalProperties.set(mapOf("serializationLibrary" to "kotlinx_serialization", "enumPropertyNaming" to "UPPERCASE", "dateLibrary" to "java8"))
}

sourceSets.named("main") { kotlin.srcDir(generated.map { it.dir("src/main/kotlin") }) }
tasks.named("compileKotlin") { dependsOn(tasks.named("openApiGenerate")) }
tasks.test { useJUnitPlatform() }
