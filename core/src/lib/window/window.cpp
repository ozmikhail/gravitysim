#include "lib/window/window.h"

#include <GLFW/glfw3.h>

#include <atomic>
#include <mutex>
#include <string>
#include <utility>

#include "error.h"

namespace grav {

namespace {

std::mutex g_init_mutex;
int g_init_count = 0;
thread_local std::string g_last_error;

void glfw_error_callback(int code, const char* description) {
    g_last_error.assign("glfw error ");
    g_last_error += std::to_string(code);
    if (description != nullptr) {
        g_last_error += ": ";
        g_last_error += description;
    }
}

void glfw_init_once() {
    std::lock_guard<std::mutex> lock(g_init_mutex);
    if (g_init_count == 0) {
        glfwSetErrorCallback(&glfw_error_callback);
        if (glfwInit() != GLFW_TRUE) {
            const std::string msg =
                std::string("glfw: init failed: ") + g_last_error;
            throw AppError::dependency_unavailable(msg);
        }
    }
    ++g_init_count;
}

void glfw_terminate_once() {
    std::lock_guard<std::mutex> lock(g_init_mutex);
    if (g_init_count == 0) return;
    --g_init_count;
    if (g_init_count == 0) {
        glfwTerminate();
    }
}

}

Window::Window(const Config& cfg) {
    glfw_init_once();

    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, cfg.gl_major);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, cfg.gl_minor);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
    glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GLFW_TRUE);
    glfwWindowHint(GLFW_RESIZABLE, GLFW_TRUE);
#ifdef __APPLE__
    glfwWindowHint(GLFW_COCOA_RETINA_FRAMEBUFFER, GLFW_TRUE);
#endif

    handle_ = glfwCreateWindow(
        cfg.width, cfg.height, cfg.title.c_str(), nullptr, nullptr
    );
    if (handle_ == nullptr) {
        const std::string msg =
            std::string("glfw: window creation failed: ") + g_last_error;
        glfw_terminate_once();
        throw AppError::dependency_unavailable(msg);
    }

    glfwMakeContextCurrent(handle_);
    glfwSwapInterval(cfg.vsync ? 1 : 0);
}

Window::~Window() {
    if (handle_ != nullptr) {
        glfwDestroyWindow(handle_);
        handle_ = nullptr;
    }
    glfw_terminate_once();
}

bool Window::should_close() const {
    return glfwWindowShouldClose(handle_) == GLFW_TRUE;
}

void Window::poll_events() { glfwPollEvents(); }

void Window::swap_buffers() { glfwSwapBuffers(handle_); }

std::pair<int, int> Window::framebuffer_size() const {
    int w = 0;
    int h = 0;
    glfwGetFramebufferSize(handle_, &w, &h);
    return {w, h};
}

std::pair<int, int> Window::window_size() const {
    int w = 0;
    int h = 0;
    glfwGetWindowSize(handle_, &w, &h);
    return {w, h};
}

float Window::dpi_scale() const {
    const auto [fb_w, fb_h] = framebuffer_size();
    const auto [wn_w, wn_h] = window_size();
    if (wn_w <= 0) return 1.0F;
    return static_cast<float>(fb_w) / static_cast<float>(wn_w);
}

}
