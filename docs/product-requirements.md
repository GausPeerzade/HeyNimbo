# Product requirements

Standing requirements every change is held to. Briefs and reviews check against this file.

## 3D designs on request
Whenever someone asks for a 3D design of anything, NimboGuide shows it live, as it speaks, with in-depth detail and without issues, and as soon as possible.

- **Any subject.** Quality comes from the general shape kit, the renderer and the authoring guidance, not from tuning for particular kinds of objects. Test models are a coverage sample, never targets to fit.
- **Live.** Parts appear as they're explained, with the pen visiting each one. The model fills its card, has depth from lighting and shadow, and keeps readable labels attached while it turns or moves.
- **Without issues.** Whatever the model writes, the result renders: no crashes, no invisible or cut-off parts, no jumps, flicker or stuck clicks. Bad lines drop alone, and odd proportions and placement are normalized.
- **One answer pipeline.** Speech, 2D and 3D use the same answer model, thinking level and streamed request. There is no separate 3D author or thinking setting.
- **Continuous presentation.** Start with a short useful spoken answer, show helpful 2D pages/marks next, then build the 3D explanation in small groups with its sentences. Do not add unnecessary pages just to delay 3D. This is authoring guidance, not a guarantee that every model follows the order.
- **As soon as possible.** Speech and early drawings do not wait for the complete answer. Geometry is prepared from arriving 3D commands while earlier audio may still be playing; reveal stays on the existing speech/drawing timeline. Keep the idle-prewarmed renderer and target smooth motion (60 fps). A single request cannot remove the provider's initial reasoning delay; real-model evaluation is needed to establish start-time or quality improvements.
