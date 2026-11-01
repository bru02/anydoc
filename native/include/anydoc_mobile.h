#ifndef ANYDOC_MOBILE_H
#define ANYDOC_MOBILE_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
// All strings are UTF-8. Runs synchronously on the caller's BACKGROUND queue.
// Returns owned JSON; free exactly once with anydoc_mobile_free.
char *anydoc_mobile_extract(const char *path, const char *filename,
                           const char *pdfium_path, uint64_t max_bytes,
                           uint32_t max_chars, uint32_t max_pages);
void anydoc_mobile_free(char *result);
#ifdef __cplusplus
}
#endif
#endif
