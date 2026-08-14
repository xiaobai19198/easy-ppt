# Easy PPT workflow reference

## Outline JSON

Use this shape for `outline-draft.json`:

```json
{
  "title": "项目介绍PPT",
  "audience": "学校管理层",
  "purpose": "说明项目价值并推动合作",
  "styleRequest": "现代、专业、可信",
  "pages": [
    {
      "page": 1,
      "title": "封面",
      "brief": "项目名称、汇报对象、机构名称和日期",
      "goal": "建立专业可信的第一印象",
      "audience": "学校管理层",
      "keyMessage": "项目名称",
      "layoutType": "封面页",
      "mustInclude": ["项目名称"],
      "avoidPatterns": ["营销海报感", "信息拥挤"]
    }
  ]
}
```

Required per page: `page`, `title`, `brief`. Recommended: `goal`, `audience`, `keyMessage`, `layoutType`, `mustInclude`, `avoidPatterns`.

Page numbers must be unique and contiguous from 1. Keep no more than 20 pages in v1.

## Page lifecycle

`empty -> generating -> draft -> confirmed`

On failure, restore the previous status and add a failed attempt record. A confirmed version remains immutable. Editing creates a new draft version; it never overwrites the confirmed file.

## Reference roles

Keep roles explicit and ordered:

1. `current_page`: present only for editing; preserve its composition unless redesign is requested.
2. `previous_page`: adjacent confirmed slide; match its design system while creating new content.
3. `global_style_anchor`: normally the confirmed cover; use its brand colors, typography, motifs, and finish.
4. `content_style_anchor`: first confirmed content slide when available; use its content hierarchy and spacing.
5. `material`: user-supplied facts, logos, photos, screenshots, or content boards; extract and incorporate content without treating it as the design style unless the user says so.

Only JPEG, PNG, and WebP assets may be multipart image references. Read document files separately and put their relevant facts into the page prompt.

Do not send duplicate files under multiple roles. The prompt names every input by its one-based multipart order.

## Rendering decisions

- Cover with no image input: generation endpoint.
- New page with any style anchor or material: edits endpoint, because edits supports creating a new image from one or more reference images.
- Revision of an existing page: edits endpoint with current page first.
- Local inpainting: edits endpoint with current source and mask; preserve everything outside the transparent mask.

## Prompt contract

Every render prompt includes:

- exact page number and outline entry;
- user instruction for this attempt;
- required facts and source-derived copy;
- design intent: layout, visual focus, hierarchy, emotion, and avoid list;
- numbered reference-role descriptions;
- mandatory landscape 16:9, edge-to-edge composition;
- explicit statement that visible copy must be audience-facing and not expose planning notes;
- for revisions, a preserve/change contract.
- a text-density decision: dense or genuinely complex pages prioritize correct, readable text and may receive a low-frequency, non-blocking rendering check only after the slide has already been shown. Covers, sparse slides, and ordinary pages normally need no check.

Avoid over-constraining decoration. Describe the communication job, hierarchy, and required content; let the renderer design a polished, modern slide.

## Style continuity

- Derive style candidates from the actual material before asking. Useful families include modern technology, restrained business, editorial minimalism, academic rigor, educational illustration, documentary humanity, premium brand, and futuristic data narrative. Offer only candidates that fit the project.
- When the user has no preference, generate three distinct cover drafts concurrently. Give each a descriptive style name; never label them only “方案 1/2/3”.
- Page 1 becomes the global style anchor when confirmed.
- Page 2 becomes the content style anchor when confirmed unless the user selects another page.
- New page N normally references confirmed N-1 plus the anchors.
- Inserting a page between N and N+1 uses confirmed N as the adjacent reference and renumbers later outline entries only after user approval.
- A user may intentionally break from the outline or request a different style. Record that instruction in the new version rather than mutating history.
