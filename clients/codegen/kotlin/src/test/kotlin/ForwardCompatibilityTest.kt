// Answers from a server newer than this client (clients/codegen/fixtures), decoded with the models and the
// serializer openapi-generator made from docs/api/v1.openapi.json: a field the client does not know is ignored,
// and a value of an open enumeration it does not know arrives as itself, for the app's own OpenEnum.Other(raw).
import com.lumenopen.lumenbox.generated.infrastructure.Serializer
import com.lumenopen.lumenbox.generated.models.Me
import com.lumenopen.lumenbox.generated.models.Meta
import com.lumenopen.lumenbox.generated.models.Error as ApiError
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class ForwardCompatibilityTest {
    private fun fixture(name: String) = File("../fixtures/$name").readText()
    private val json = Serializer.kotlinxSerializationJson

    @Test fun metaWithUnknownFieldsAndValues() {
        val meta = json.decodeFromString(Meta.serializer(), fixture("meta.json"))
        assertEquals("1.7", meta.api)
        assertEquals("federation", meta.installation.mode)
    }

    @Test fun meWithUnknownFieldsAndValues() {
        val me = json.decodeFromString(Me.serializer(), fixture("me.json"))
        assertEquals("overseer", me.role)
        assertEquals("robot", me.credential.kind)
        assertEquals(listOf("work:read", "time:travel"), me.credential.scopes)
        assertEquals(listOf("a7"), me.credential.view?.agentIds)
        assertNotNull(me.credential.lastUsedAt)
    }

    @Test fun anErrorWithAnUnknownCode() {
        val error = json.decodeFromString(ApiError.serializer(), fixture("error.json"))
        assertEquals("api-teapot", error.code)
    }
}
