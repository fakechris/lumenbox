// Answers from a server newer than this client (clients/codegen/fixtures), decoded with the models and the
// serializer openapi-generator made from docs/api/v1.openapi.json: a field the client does not know is ignored,
// and a value of an open enumeration it does not know arrives as itself, for the app's own OpenEnum.Other(raw).
import com.lumenopen.lumenbox.generated.infrastructure.Serializer
import com.lumenopen.lumenbox.generated.models.Me
import com.lumenopen.lumenbox.generated.models.Meta
import com.lumenopen.lumenbox.generated.models.Changes
import com.lumenopen.lumenbox.generated.models.AuthProviderList
import com.lumenopen.lumenbox.generated.models.DevicePage
import com.lumenopen.lumenbox.generated.models.DeviceSignIn
import com.lumenopen.lumenbox.generated.models.InboxPage
import com.lumenopen.lumenbox.generated.models.DecisionAck
import com.lumenopen.lumenbox.generated.models.WorkPage
import com.lumenopen.lumenbox.generated.models.Error as ApiError
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

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

    @Test fun workWithAStateThisClientDoesNotKnow() {
        val page = json.decodeFromString(WorkPage.serializer(), fixture("work-page.json"))
        assertEquals("paused", page.items.first().state)
        assertEquals("sign-off", page.items.first().waitKind)
        assertEquals(true, page.items.first().waitsOnMe)
    }

    @Test fun changesOfAKindThisClientDoesNotKnow() {
        val changes = json.decodeFromString(Changes.serializer(), fixture("changes.json"))
        assertEquals(listOf("work", "conversation"), changes.items.map { it.type })
        assertEquals(9007199254740001L, changes.durableSeq)
    }

    @Test fun providersOfATypeThisClientDoesNotKnow() {
        val providers = json.decodeFromString(AuthProviderList.serializer(), fixture("auth-providers.json"))
        assertEquals(listOf("dingtalk", "wecom"), providers.items.map { it.type })
    }

    @Test fun aSignInWithUnknownFieldsAndValues() {
        val signedIn = json.decodeFromString(DeviceSignIn.serializer(), fixture("device-sign-in.json"))
        assertEquals("authenticated", signedIn.status)
        assertEquals("DPoP", signedIn.tokens?.tokenType)
        assertEquals("device", signedIn.me?.credential?.kind)
        val other = json.decodeFromString(DeviceSignIn.serializer(), fixture("device-sign-in-other.json"))
        assertEquals("mfa_required", other.status)
        assertNull(other.tokens)
    }

    @Test fun devicesOfAPlatformThisClientDoesNotKnow() {
        val page = json.decodeFromString(DevicePage.serializer(), fixture("device-page.json"))
        assertEquals(listOf("visionos", "ios"), page.items.map { it.platform })
        assertEquals("passkey", page.items.first().signInMethod)
    }

    @Test fun anInboxWithKindsThisClientDoesNotKnow() {
        val page = json.decodeFromString(InboxPage.serializer(), fixture("inbox-page.json"))
        assertEquals(listOf("approval", "meeting-invite", "outbox"), page.items.map { it.kind })
        assertEquals("Writer invites you to a review at 15:00", page.items[1].title)
        assertEquals("teleport", page.items[0].approval?.tier)
        assertEquals("fax", page.items[2].draft?.kind)
    }

    @Test fun aDecisionWithAnOutcomeThisClientDoesNotKnow() {
        val ack = json.decodeFromString(DecisionAck.serializer(), fixture("decision-ack.json"))
        assertEquals("escalated", ack.outcome)
    }

    @Test fun anErrorWithAnUnknownCode() {
        val error = json.decodeFromString(ApiError.serializer(), fixture("error.json"))
        assertEquals("api-teapot", error.code)
    }
}
