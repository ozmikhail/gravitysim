#pragma once

#include <cstdint>

namespace grav::gl {

std::uint32_t compile_program(const char* vertex_src, const char* fragment_src);
void delete_program(std::uint32_t program);

}
