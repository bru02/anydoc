#ifndef ANYDOC_MOBILE_H
#define ANYDOC_MOBILE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// All strings are UTF-8. Runs synchronously on the caller's BACKGROUND queue.
// Returns owned JSON; free exactly once with anydoc_mobile_free.
// OCR callbacks borrow one page's pixels only until they return, in the layout
// the host requested: rows tightly packed, top row first. They return owned JSON
// words {text,bbox:[x1,y1,x2,y2],confidence} or {error:string}. Mode: 0 off, 1 fast, 2 accurate.
enum {
  ANYDOC_OCR_PIXELS_RGB8 = 0,  // red, green, blue
  ANYDOC_OCR_PIXELS_BGRX8 = 1, // blue, green, red, unused; PDFium's own render, no conversion
  ANYDOC_OCR_PIXELS_GRAY8 = 2, // Rec. 601 luma
};
typedef char *(*anydoc_ocr_recognize)(const uint8_t *pixels, uint64_t length, uint32_t width,
                                      uint32_t height, uint32_t pixel_format, uint32_t mode);
typedef void (*anydoc_ocr_free)(char *);
char *anydoc_mobile_extract(const char *path, const char *filename,
                           const char *pdfium_path, uint64_t max_bytes,
                           uint32_t max_chars, uint32_t max_pages,
                           uint32_t ocr_mode, uint32_t ocr_pixel_format,
                           anydoc_ocr_recognize recognize,
                           anydoc_ocr_free free_ocr);
void anydoc_mobile_free(char *result);
#ifdef __cplusplus
}
#endif
#endif
