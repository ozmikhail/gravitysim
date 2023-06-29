#include "lib/gl/gl.h"

#include <glad/gl.h>

#include <GLFW/glfw3.h>

#include <format>
#include <string_view>

#include "error.h"

namespace grav::gl {

namespace {

void GLAPIENTRY debug_callback(
    GLenum,
    GLenum type,
    GLuint,
    GLenum severity,
    GLsizei,
    const GLchar* message,
    const void*
) {
    if (type == GL_DEBUG_TYPE_PUSH_GROUP || type == GL_DEBUG_TYPE_POP_GROUP) return;
    if (severity == GL_DEBUG_SEVERITY_NOTIFICATION) return;
    std::fputs("gl debug: ", stderr);
    std::fputs(message != nullptr ? message : "(null)", stderr);
    std::fputc('\n', stderr);
}

}

void init() {
    if (gladLoadGL(reinterpret_cast<GLADloadfunc>(&glfwGetProcAddress)) == 0) {
        throw AppError::dependency_unavailable("gl: glad load failed");
    }

    if (GLAD_GL_VERSION_4_3 != 0) {
        glEnable(GL_DEBUG_OUTPUT);
        glEnable(GL_DEBUG_OUTPUT_SYNCHRONOUS);
        glDebugMessageCallback(&debug_callback, nullptr);
    }
}

void check(std::string_view op) {
    const GLenum err = glGetError();
    if (err != GL_NO_ERROR) {
        throw AppError::dependency_unavailable(std::format("gl: {}: 0x{:x}", op, err));
    }
}

const char* renderer() {
    return reinterpret_cast<const char*>(glGetString(GL_RENDERER));
}

const char* version() {
    return reinterpret_cast<const char*>(glGetString(GL_VERSION));
}

void set_viewport(int width, int height) { glViewport(0, 0, width, height); }

void clear(float r, float g, float b, float a) {
    glClearColor(r, g, b, a);
    glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT);
}

}
