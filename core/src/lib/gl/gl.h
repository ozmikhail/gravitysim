#ifndef GRAV_LIB_GL_GL_H
#define GRAV_LIB_GL_GL_H

#include <string>
#include <string_view>
#include <vector>

namespace grav::gl {

void init();

void check(std::string_view operation);

std::string renderer();
std::string version();

void read_rgb(int width, int height, std::vector<unsigned char>& rgb);
void set_viewport(int width, int height);
void clear(float red, float green, float blue, float alpha);

} // namespace grav::gl

#endif // GRAV_LIB_GL_GL_H
