#include "lib/gl/gl.h"

#include "error.h"

#include <GLFW/glfw3.h>
#include <cstddef>
#include <format>
#include <glad/gl.h>
#include <iostream>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

namespace grav::gl {

namespace {

std::string gl_string(GLenum name) {
  const GLubyte* text = glGetString(name);
  if (text == nullptr) {
    return "(null)";
  }
  const GLubyte* end = text;
  while (*end != 0) {
    end = std::next(end);
  }
  return {text, end};
}

} // namespace

void init() {
  if (gladLoadGL(glfwGetProcAddress) == 0) {
    throw AppError::dependency_unavailable("gl: glad load failed");
  }

  if (GLAD_GL_VERSION_4_3 != 0) {
    const GLDEBUGPROC debug_callback = [](GLenum /*source*/, GLenum type, GLuint /*id*/,
                                          GLenum severity, GLsizei /*length*/,
                                          const GLchar* message, const void* /*user_param*/) {
      if (type == GL_DEBUG_TYPE_PUSH_GROUP || type == GL_DEBUG_TYPE_POP_GROUP) {
        return;
      }
      if (severity == GL_DEBUG_SEVERITY_NOTIFICATION) {
        return;
      }
      std::cerr << "gl debug: " << (message != nullptr ? message : "(null)") << '\n';
    };
    glEnable(GL_DEBUG_OUTPUT);
    glEnable(GL_DEBUG_OUTPUT_SYNCHRONOUS);
    glDebugMessageCallback(debug_callback, nullptr);
  }
}

void check(std::string_view operation) {
  const GLenum err = glGetError();
  if (err != GL_NO_ERROR) {
    throw AppError::dependency_unavailable(std::format("gl: {}: 0x{:x}", operation, err));
  }
}

std::string renderer() { return gl_string(GL_RENDERER); }

std::string version() { return gl_string(GL_VERSION); }

void read_rgb(int width, int height, std::vector<unsigned char>& rgb) {
  rgb.resize(static_cast<std::size_t>(width) * height * 3);
  GLint alignment = 0;
  glGetIntegerv(GL_PACK_ALIGNMENT, &alignment);
  glPixelStorei(GL_PACK_ALIGNMENT, 1);
  glReadPixels(0, 0, width, height, GL_RGB, GL_UNSIGNED_BYTE, rgb.data());
  glPixelStorei(GL_PACK_ALIGNMENT, alignment);
  check("read framebuffer");
}

void set_viewport(int width, int height) { glViewport(0, 0, width, height); }

void clear(float red, float green, float blue, float alpha) {
  glClearColor(red, green, blue, alpha);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
}

} // namespace grav::gl
