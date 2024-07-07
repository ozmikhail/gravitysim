#pragma once

#include <vector>

#include <string_view>

namespace grav::gl {

void init();

void check(std::string_view op);

const char* renderer();
const char* version();

void read_rgb(int width, int height, std::vector<unsigned char>& rgb);
void set_viewport(int width, int height);
void clear(float r, float g, float b, float a);

}
