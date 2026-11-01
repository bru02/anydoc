#ifndef ANYDOC_MOBILE_H
#define ANYDOC_MOBILE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// All strings are UTF-8. Runs synchronously on the caller's BACKGROUND queue.
// Returns owned JSON; free exactly once with anydoc_mobile_free.
// OCR callbacks borrow tightly-packed RGB (3 bytes/pixel), returning owned JSON
// words {text,bbox:[x1,y1,x2,y2],confidence} or {error:string}. Mode: 0 off, 1 fast, 2 accurate.
typedef char *(*anydoc_ocr_recognize)(const uint8_t *, uint64_t, uint32_t, uint32_t, uint32_t);
typedef void (*anydoc_ocr_free)(char *);
char *anydoc_mobile_extract(const char *path, const char *filename,
                           const char *pdfium_path, uint64_t max_bytes,
                           uint32_t max_chars, uint32_t max_pages,
                           uint32_t ocr_mode, anydoc_ocr_recognize recognize,
                           anydoc_ocr_free free_ocr);
void anydoc_mobile_free(char *result);
#ifdef __cplusplus
}
#endif
#endif
