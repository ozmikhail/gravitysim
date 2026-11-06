#ifndef GRAV_LIB_GL_SHADER_H
#define GRAV_LIB_GL_SHADER_H

#include <cstdint>

namespace grav::gl {

std::uint32_t compile_program(const char* vertex_src, const char* fragment_src);
void delete_program(std::uint32_t program);

} // namespace grav::gl

#endif // GRAV_LIB_GL_SHADER_H
