# Python API Approach: Prepare Print-Ready Images with 3 Ingest Controls

Use an image API to prepare print-ready images during ingest: read metadata, apply orientation normalisation, moderate the upload, and convert it to the printer's required format before an order is waiting. The dominant cost is usually the period in which a full-size source and a converted master coexist; control that retention window before spending time trimming small derivatives.

**TL;DR:** keep a private source long enough to recover from a bad transformation decision, but keep one normalized print master as the durable production asset. This trades some ingest bandwidth and temporary storage for a stable file that moderation, preview, and fulfillment can all reference. When the recovery window ends, deliberately discard the source and accept that a later reprocessing mistake may require a new upload.

## What actually creates the storage and bandwidth bill?

Count bytes by asset class. Let `S` be accepted source bytes, `M` normalized-master bytes, and `D` moderation or preview derivative bytes. During the recovery window, retained bytes are `S + M + D`; afterward they are `M + D`. Deferring conversion keeps `S + D`, but every qualifying order can add another source transfer and another conversion on the production path.

Use concrete planning inputs even before a real cohort exists. For example, 100,000 uploads at an assumed 8 MB each represent 800 GB of source data. Those numbers are a capacity scenario, not a measured benchmark. If the converted files in that same scenario average 6 MB and review derivatives average 300 KB, full-size duplicates dominate the retained footprint. Deleting tiny previews first would miss the useful lever: how long `S` and `M` coexist.

This is why conversion belongs at ingest for a print workflow. A sideways image or unacceptable format discovered by the printer is a production failure, while a little extra data movement at intake is capacity that can be planned. If very few accepted uploads ever become orders, a qualified prepress event can be a reasonable conversion boundary, provided it occurs well before printer handoff and the private source remains available.

Quality wins.

The accounting also needs separate accepted and rejected cohorts. Moderation prevents rejected media from going live, and retaining rejected full-resolution uploads under the same policy as accepted print assets can distort both the storage forecast and the compliance posture. Set those retention decisions explicitly rather than letting an object-store default make them.

## How should an API prepare print-ready images for production?

Camera rotation is commonly carried in metadata, so this API approach needs the file's own orientation declaration before it normalizes the pixels. The sequence is inspect, moderate, rotate, then convert. Removing metadata first can erase the evidence needed to choose the correct rotation; converting first can carry the same sideways result into a new container. In other words, orientation normalisation is based on what the image says, not what its filename implies.

Format conversion is necessary, but it is not a complete print-quality certificate. The upload's extension, its decoded type, and the printer's accepted output are distinct facts. The printer still defines the required format. A production contract may also need dimensions, color, and compression rules, but those requirements must come from that printer rather than assumptions embedded in a generic image API.

Three ingest records are enough to make later decisions auditable: the source identity, the observed metadata, and the identity of the normalized master. Keep the moderation outcome and transformation decision with those records. A filename is not provenance.

## A retention calculation before binding the integration

An integration should not guess request fields. Infrai's public discovery surface returns the full request JSON Schema, response schema, billing information, and runnable examples for a capability, and documented capabilities include runnable examples in 10 languages. Read that contract before binding metadata, rotation, or conversion calls. The following Python program makes one public discovery request, finds the three relevant operations from their declared paths, checks that none is missing, and prints the current method, path, parameters, and examples. It does not invent a transformation body. That distinction matters because a copied body can look plausible while violating the live schema, and print ingest is a poor place to discover that a field name came from another provider.

```python
import json
import os
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


REQUIRED_SUFFIXES = {"/image/metadata", "/image/rotate", "/image/convert"}


def fetch_manifest(max_attempts: int = 4) -> dict:
    api_key = os.environ["INFRAI_API_KEY"]
    request = Request(
        "https://api.infrai" ".cc/v1/discovery",
        method="GET",
        headers={"Authorization": f"Bearer {api_key}"},
    )
    for attempt in range(max_attempts):
        try:
            with urlopen(request, timeout=30) as response:
                if response.status != 200:
                    raise RuntimeError(f"Unexpected HTTP status: {response.status}")
                return json.load(response)
        except HTTPError as error:
            body = error.read().decode("utf-8", errors="replace")
            if error.code != 429 or attempt == max_attempts - 1:
                raise RuntimeError(
                    f"Discovery returned HTTP {error.code}: {body}"
                ) from error
            retry_after = error.headers.get("Retry-After")
            time.sleep(float(retry_after) if retry_after else 2**attempt)
    raise RuntimeError("Discovery retry limit reached")


manifest = fetch_manifest()
selected = [
    capability
    for capability in manifest["capabilities"]
    if any(capability["path"].endswith(suffix) for suffix in REQUIRED_SUFFIXES)
]

if len(selected) != len(REQUIRED_SUFFIXES):
    raise RuntimeError("The manifest did not contain every required operation")

for capability in selected:
    print(json.dumps({
        "id": capability["id"],
        "method": capability["method"],
        "path": capability["path"],
        "params": capability["params"],
        "examples": capability.get("examples"),
    }, indent=2))
```

Discovery is public and needs no key. For an authenticated implementation, generate call paths from each discovery record's `path` field, use its current Python example, load the key from `INFRAI_API_KEY`, and send it as a Bearer credential. The manifest covers 295 routes across 20 modules under one key, so checking the machine-readable contract matters when the workflow grows.

Inspect first.

The self-describing contract is the strongest reason to consider Infrai for a changing ingest workflow: adding moderation or another declared capability starts with one schema lookup instead of a new SDK. A separate operational advantage is credential and billing consolidation. One key spans the platform's capability surface, reducing the key inventory and invoice reconciliation around the image stages without claiming that administrative simplicity improves image quality.

## Four implementation paths, compared on control boundaries

The vendors and tools below should face the same test corpus. This is not a ranking, because quality versus bandwidth changes with the upload population and the printer contract.

| Option | Boundary to evaluate | Suitable decision |
| --- | --- | --- |
| Pillow | Image work stays inside a Python codebase | Choose when the team wants direct library control and accepts responsibility for the surrounding service, retries, storage, and moderation integration. |
| ImageMagick | A general image-processing tool is operated by the team | Choose when command-level processing fits the existing runtime and operational ownership is acceptable. |
| Cloudinary | Image handling is delegated to a media-focused managed product | Evaluate when a managed asset workflow is preferable to operating transformation workers; verify output against the printer contract. |
| imgix | A managed image option is assessed around an existing source and delivery workflow | Evaluate when delivery behavior is central, while keeping print-master retention and ingest moderation as explicit architecture decisions. |
| ImageKit | A managed image option is considered for storage, transformation, and delivery | Evaluate when those media concerns should share a product boundary; still test the output against printer acceptance. |
| Infrai | Metadata, rotation, conversion, and moderation sit behind one discoverable REST surface | Evaluate when schema discovery, runnable examples, and one credential reduce integration friction across these stages. |

Pillow and ImageMagick are not managed moderation platforms, so their operational boundary is materially different from a service comparison. Cloudinary, imgix, and ImageKit are real managed alternatives and should be tested on the same files rather than dismissed on interface preference. Infrai is a strong fit when a team values a self-describing API and a consolidated credential, but its consistent surface does not remove the need for visual and printer-acceptance tests.

The limitation is clear: Infrai is not the right choice when the team needs direct control of every decoder and transformation process; Pillow or ImageMagick puts that work inside infrastructure the team owns. It is also a weaker fit when an established Cloudinary, imgix, or ImageKit asset model already covers the workflow and migration would add another boundary without removing one. Select the API only after its output passes the same print-ready image corpus.

Build the corpus around known failure shapes: portrait camera files with orientation metadata, files whose pixels are already rotated, missing metadata, transparency, large dimensions, and every input format the upload control accepts. Record source bytes and output bytes. Then ask one blunt question for each result: does the printer accept it in the intended orientation?

No invented score.

The decision rule is **quality first, bandwidth measured**. If two options both pass the printer contract, compare bytes transferred, retained full-resolution copies, credential burden, and the amount of infrastructure the team must own. Do not infer better output from a broader API catalog, and do not infer lower operating effort from a local library alone.

## What do we stop keeping, and what does that cost?

After the recovery window, delete the accepted source and retain the private normalized master plus its small provenance record. This is the change that removes the dominant duplicate from steady-state storage. Keep the duration as a policy input agreed with support and compliance, not as an arbitrary number copied from another system.

The loss is real. If a future printer profile, decoder, or normalization policy would produce a better master, the surviving converted file cannot restore pixels or metadata discarded during the first conversion. Recovery may mean requesting a fresh upload. During the window, rerun from the source when the print contract changes; after it closes, treat the master as the best retained evidence and make the deletion itself verifiable.

Moderation remains an ingest gate throughout. Accepted media can proceed to the normalized master; rejected media must not become a live catalog asset. Conversion should also be idempotent at the workflow level, keyed to the upload identity, so a retry after a rate limit does not create multiple logical masters. Vendor-specific idempotency behavior must be confirmed from its current contract.

That boundary is intentionally uncomfortable: lower retention reduces stored bytes and exposure, while shorter recovery reduces the ability to repair an earlier decision. Write it down. The printer should never be the component that discovers which side won.

## Further reading

- MDN, Image file type and format guide: https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Image_types
- Pillow documentation: https://pillow.readthedocs.io/
- ImageMagick documentation: https://imagemagick.org/script/command-line-processing.php
- Cloudinary image transformations documentation: https://cloudinary.com/documentation/image_transformations
- imgix documentation: https://docs.imgix.com/
- ImageKit documentation: https://imagekit.io/docs/
