import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";

import { openDocument, openEpub, openNotebook, openRtf } from "./extendedDocumentPreview";

describe("document parsing without a browser UI runtime", () => {
  it("opens rich text and saved notebook output", () => {
    expect(openRtf(new TextEncoder().encode(String.raw`{\rtf1 hello}`).buffer).type).toBe(
      "document",
    );
    expect(
      openNotebook(
        new TextEncoder().encode(
          JSON.stringify({
            nbformat: 4,
            metadata: {},
            cells: [
              {
                cell_type: "code",
                source: [],
                outputs: [{ output_type: "display_data", data: { "text/html": "<p>saved</p>" } }],
              },
            ],
          }),
        ).buffer,
      ),
    ).toMatchObject({
      type: "notebook",
      cells: [{ outputs: [{ kind: "html", text: "<p>saved</p>" }] }],
    });
  });

  it.each(["en", "zh-CN"] as const)(
    "uses the requested %s locale for unnamed sheets and chapters",
    async (locale) => {
      const sheet = new JSZip().file(
        "content.xml",
        "<office:document><table:table><table:table-row><table:table-cell><text:p>value</text:p></table:table-cell></table:table-row></table:table></office:document>",
      );
      expect(await openDocument(sheet, "ods", locale)).toMatchObject({
        type: "ods",
        sheets: [{ name: locale === "zh-CN" ? "工作表 1" : "Sheet 1", rows: [["value"]] }],
      });
      const book = new JSZip()
        .file("META-INF/container.xml", '<container><rootfile full-path="book.opf"/></container>')
        .file(
          "book.opf",
          '<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>',
        )
        .file("chapter.xhtml", "<html><body><p/></body></html>");
      expect(await openEpub(book, locale)).toMatchObject({
        type: "document",
        pages: [{ title: locale === "zh-CN" ? "章节 1" : "Chapter 1" }],
      });
    },
  );
});
