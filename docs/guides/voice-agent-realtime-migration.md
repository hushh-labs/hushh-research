# Voice Agent Real-time Migration Guide

## Visual Context

This guide inherits its layout and security model from the [Documentation Architecture Map](../reference/operations/documentation-architecture-map.md) and [IAM Architecture](../reference/iam/architecture.md).

## Overview

This document outlines the migration from the current WebSocket/polling architecture to OpenAI's real-time API for the Kai voice assistant. This migration will reduce latency from ~800ms to <200ms per response.

**Status:** Ready for implementation
**Priority:** High (Issue #597)
**Expected Timeline:** 2-3 sprints

---

## Current Architecture (Baseline)

### Data Flow
```
User Speech (STT)
    ↓
Frontend STT Processing (~100ms)
    ↓
HTTP POST to backend planner
    ↓
Backend processes context + calls LLM (~400-600ms)
    ↓
HTTP Response with action_id
    ↓
Frontend executes action
    ↓
Compose response + TTS (~200ms)
    ↓
User hears response (~800-1000ms total)
```

### Issues
- **Latency**: 800-1000ms end-to-end (high for real-time UX)
- **Polling**: Fallback polling for long operations adds jitter
- **Error Recovery**: Network failures require full re-request
- **Scalability**: One HTTP connection per request

---

## Target Architecture (OpenAI Real-time API)

### Data Flow
```
User Speech (STT) [100ms]
    ↓
OpenAI Real-time WebSocket connection
    ↓
Streaming Partial Responses (interactive)
    ↓
Real-time Function Calling (no round-trip delay)
    ↓
Frontend executes actions in parallel
    ↓
Streaming TTS audio chunks [100ms]
    ↓
User hears response <200ms total
```

### Benefits
- **Sub-200ms latency** (feels native)
- **Streaming responses** (progressive rendering)
- **Built-in function calling** (no round-trip serialization)
- **Error recovery** (persistent connection, automatic retry)
- **Scalability** (persistent WebSocket, not per-request)

---

## Migration Path

### Phase 1: Setup & Integration (Sprint 1)

#### 1.1 Install OpenAI Real-time SDK
```bash
uv add openai>=1.0.0  # backend
npm install openai-realtime  # frontend (if available)
```

#### 1.2 Create Real-time Wrapper Service
```python
# consent-protocol/services/openai_realtime_service.py
from openai import OpenAI

class OpenAIRealtimeService:
    def __init__(self, api_key: str):
        self.client = OpenAI(api_key=api_key)
    
    async def create_session(
        self,
        model: str = "gpt-4o-realtime-preview",
        voice: str = "shimmer",
        instructions: str = ""
    ) -> RealtimeSession:
        """Create a persistent real-time session"""
        session = await self.client.beta.realtime.sessions.create(
            model=model,
            voice=voice,
            instructions=instructions,
            input_audio_format="pcm16",
            output_audio_format="pcm16"
        )
        return session
    
    async def send_audio(
        self,
        session_id: str,
        audio_bytes: bytes
    ) -> AsyncIterator[RealtimeEvent]:
        """Stream audio and receive real-time responses"""
        # Implementation handles connection pooling
        pass
```

#### 1.3 Update Kai Voice Route
```python
# consent-protocol/routes/kai/voice.py

@router.post("/voice/realtime-session")
async def create_voice_session(
    request: CreateVoiceSessionRequest,
    current_user: User = Depends(get_current_user),
) -> CreateVoiceSessionResponse:
    """Create OpenAI real-time session with consent token"""
    session = await realtime_service.create_session(
        instructions=f"""
        You are Kai, a financial advisor.
        User consent token: {request.consent_token}
        Access scopes: {request.scopes}
        """
    )
    return CreateVoiceSessionResponse(
        session_id=session.id,
        client_secret=session.client_secret,  # Secure ephemeral token
    )

@router.websocket("/voice/realtime/{session_id}")
async def voice_realtime_stream(
    websocket: WebSocket,
    session_id: str,
):
    """Stream audio bidirectionally"""
    await websocket.accept()
    async for event in realtime_service.send_audio(
        session_id=session_id,
        audio_bytes=await websocket.receive_bytes(),
    ):
        await websocket.send_json(event)
```

---

### Phase 2: Frontend Integration (Sprint 2)

#### 2.1 Update Audio Capture
```typescript
// hushh-webapp/services/voice-capture-service.ts

export class VoiceRealtimeCaptureService {
  private session: RealtimeSession | null = null;
  private connection: WebSocket | null = null;

  async startSession(consentToken: string) {
    // Get session from backend
    const response = await fetch('/kai/voice/realtime-session', {
      method: 'POST',
      body: JSON.stringify({
        consent_token: consentToken,
        scopes: ['vault.read', 'portfolio.read'],
      }),
    });
    
    const { session_id, client_secret } = await response.json();
    
    // Connect WebSocket for real-time streaming
    this.connection = new WebSocket(
      `wss://api.openai.com/beta/realtime?model=gpt-4o-realtime-preview`,
      ['realtime', `ot_bearer_${client_secret}`]
    );
    
    this.setupMessageHandlers();
  }

  private setupMessageHandlers() {
    this.connection!.onmessage = async (event) => {
      const realtimeEvent = JSON.parse(event.data);
      
      switch (realtimeEvent.type) {
        case 'response.audio.delta':
          // Stream audio chunks to user
          this.playAudioChunk(realtimeEvent.delta);
          break;
        case 'response.function_call_arguments.delta':
          // Real-time function calling (e.g., "buy 10 AAPL")
          await this.handleFunctionCall(realtimeEvent);
          break;
        case 'response.done':
          this.finalizeTurn();
          break;
      }
    };
  }

  async sendAudioFrame(frame: AudioFrame) {
    this.connection!.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: frame.base64Data,
    }));
  }
}
```

#### 2.2 Real-time UI Rendering
```tsx
// hushh-webapp/app/kai/voice/realtime-voice.tsx

export function RealtimeVoiceAssistant() {
  const [isListening, setIsListening] = useState(false);
  const [partialText, setPartialText] = useState('');
  const [audioChunks, setAudioChunks] = useState<Uint8Array[]>([]);

  const voiceService = useVoiceRealtimeService();

  const handleVoiceStart = async () => {
    setIsListening(true);
    await voiceService.startSession(userConsentToken);
    
    // Stream audio from microphone
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const processor = new AudioWorkletNode(audioContext, 'voice-processor');
    
    processor.port.onmessage = ({ data: { audio } }) => {
      voiceService.sendAudioFrame(audio);
    };
  };

  // Listen for real-time responses
  voiceService.onPartialText((text) => {
    setPartialText(text);  // Show live transcription
  });

  voiceService.onAudioChunk((chunk) => {
    setAudioChunks(prev => [...prev, chunk]);  // Stream TTS
  });

  return (
    <div>
      <button onClick={handleVoiceStart}>
        {isListening ? '🎙️ Listening...' : 'Start Voice'}
      </button>
      <div className="transcript">{partialText}</div>
    </div>
  );
}
```

---

### Phase 3: Error Handling & Fallbacks (Sprint 3)

#### 3.1 Connection Resilience
```python
# consent-protocol/services/openai_realtime_service.py

async def with_reconnect(
    self,
    session_id: str,
    max_retries: int = 3,
    backoff_base: float = 1.0
):
    """Automatic reconnect with exponential backoff"""
    for attempt in range(max_retries):
        try:
            async for event in self.send_audio(session_id):
                yield event
        except WebSocketError as e:
            if attempt < max_retries - 1:
                wait_time = backoff_base ** attempt
                await asyncio.sleep(wait_time)
                logger.info(f"Reconnecting after {wait_time}s...")
            else:
                raise
```

#### 3.2 Fallback to Legacy Mode
```python
@router.post("/voice/realtime-session")
async def create_voice_session(request: CreateVoiceSessionRequest):
    if is_realtime_disabled():  # Feature flag
        return LegacyVoiceResponse(
            use_legacy=True,
            endpoint="/voice/legacy-planner"
        )
    
    return RealtimeSessionResponse(...)
```

#### 3.3 Network Quality Adaptation
```typescript
// hushh-webapp/services/voice-quality-service.ts

export class VoiceQualityService {
  private connection: Connection;

  async adaptToNetworkQuality() {
    const quality = await this.measureNetworkQuality();
    
    if (quality.bandwidth < 256 * 1024) {  // < 256 kbps
      // Degrade audio quality, use fallback
      this.switchToLegacyMode();
    } else if (quality.latency > 150) {  // > 150ms
      // Increase buffer, reduce streaming updates
      this.adjustBufferSize(500);
    } else {
      // Optimal conditions, use full real-time
      this.adjustBufferSize(100);
    }
  }
}
```

---

## Test Coverage Requirements

### Unit Tests
```python
# consent-protocol/tests/services/test_openai_realtime_service.py

@pytest.mark.asyncio
async def test_create_session_with_consent_token():
    """Verify session respects consent token scopes"""
    service = OpenAIRealtimeService(api_key="test")
    session = await service.create_session(
        instructions="Access scopes: vault.read"
    )
    assert session.instructions.includes("vault.read")

@pytest.mark.asyncio
async def test_reconnect_with_backoff():
    """Verify exponential backoff on disconnection"""
    service = OpenAIRealtimeService(api_key="test")
    with patch('asyncio.sleep') as mock_sleep:
        await service.with_reconnect(
            session_id="test",
            max_retries=3,
            backoff_base=2.0
        )
        # Verify sleep calls: 1s, 2s, 4s
        assert mock_sleep.call_count == 2

@pytest.mark.asyncio
async def test_pii_detection_in_responses():
    """Ensure LLM responses scrubbed of PII"""
    event = {
        "type": "response.text.delta",
        "text": "Your SSN 123-45-6789 is confirmed"
    }
    scrubbed = scrub_pii_from_event(event)
    assert "123-45-6789" not in scrubbed.text
```

### Integration Tests
```python
# consent-protocol/tests/integration/test_voice_realtime_flow.py

@pytest.mark.integration
@pytest.mark.asyncio
async def test_end_to_end_voice_command():
    """Test full voice command flow with real OpenAI API"""
    client = AsyncClient(app=app, base_url="http://test")
    
    # 1. Create session
    session_response = await client.post(
        "/kai/voice/realtime-session",
        json={"consent_token": VALID_TOKEN, "scopes": ["vault.read"]}
    )
    assert session_response.status_code == 200
    
    # 2. Simulate audio stream
    audio_bytes = load_test_audio("buy_ten_apple.wav")
    
    # 3. Verify response structure
    response = await client.websocket_connect(
        f"/kai/voice/realtime/{session_response.json()['session_id']}"
    )
    await response.send_bytes(audio_bytes)
    
    # 4. Verify execution
    result = await response.receive_json()
    assert result['type'] == 'response.function_call_arguments.delta'
    assert '"symbol": "AAPL"' in result['arguments']
```

### E2E Tests (Playwright)
```typescript
// hushh-webapp/__tests__/e2e/voice-realtime.spec.ts

test('voice command executes in <200ms', async ({ page }) => {
  await page.goto('/kai/voice');
  
  const startTime = performance.now();
  
  await page.locator('[data-testid="voice-button"]').click();
  // Simulate audio input
  await page.evaluate(() => {
    window.simulateAudioInput('buy ten apple');
  });
  
  // Wait for response
  await expect(page.locator('[data-testid="function-execution"]'))
    .toBeVisible({ timeout: 200 });
  
  const duration = performance.now() - startTime;
  expect(duration).toBeLessThan(200);
});

test('fallback to legacy mode on network degradation', async ({ page }) => {
  // Enable network throttling
  await page.route('**/*', route => {
    route.continue({ delay: 500 });  // Simulate 500ms latency
  });
  
  await page.goto('/kai/voice');
  const legacyNotice = await page.locator('[data-testid="legacy-mode-notice"]');
  
  // System should automatically degrade
  expect(legacyNotice).toBeVisible();
});
```

---

## Latency Budget

| Component | Current | Target | Notes |
|-----------|---------|--------|-------|
| Frontend STT | 100ms | 100ms | Same |
| Network + Backend LLM | 400-600ms | 50-100ms | Real-time API handles this |
| Function calling | 100-200ms | 10-20ms | Parallel execution |
| TTS | 200ms | 50ms | Streaming chunks |
| **Total** | **800-1100ms** | **<200ms** | **6x improvement** |

---

## Rollout Strategy

### Week 1-2: Canary Deployment
- Deploy real-time service to 5% of users
- Monitor latency, error rates, user feedback
- Feature flag: `voice_realtime_enabled`

### Week 3-4: Beta
- Expand to 25% of users
- Gather feedback, iterate on UX

### Week 5+: Full Rollout
- 100% migration (with legacy fallback always available)
- Deprecate legacy voice endpoint in next major version

---

## Monitoring & Observability

### Key Metrics
```python
# consent-protocol/observability/voice_metrics.py

voice_latency = Histogram(
    'kai_voice_latency_ms',
    buckets=[50, 100, 150, 200, 300, 500],
    labels=['endpoint', 'status'],
)

realtime_connections = Gauge(
    'kai_realtime_connections_active',
)

function_call_latency = Histogram(
    'kai_function_call_latency_ms',
)
```

### Alerts
- Voice latency > 300ms: Page
- Real-time connection drop rate > 1%: Alert
- PII detection triggered: Security alert

---

## Rollback Plan

If real-time migration causes issues:

1. **Immediate**: Flip feature flag to 0%
2. **Short-term**: Run both systems in parallel (real-time + legacy)
3. **Medium-term**: Debug with canary group, iterate
4. **Long-term**: Retry rollout with fixes

---

## Success Criteria

- ✅ Voice latency <200ms for 95th percentile
- ✅ Connection uptime >99.5%
- ✅ All function calls execute in <50ms
- ✅ PII scrubbing 100% effective
- ✅ Mobile parity (iOS/Android) maintained
- ✅ Backward compatibility with legacy mode

---

## References

- [OpenAI Real-time API Docs](https://platform.openai.com/docs/guides/realtime)
- [Current Voice Runtime Architecture](../reference/kai/kai-voice-runtime-architecture.md)
- [Issue #597: Voice Agent Latency](https://github.com/hushh-labs/hushh-research/issues/597)
