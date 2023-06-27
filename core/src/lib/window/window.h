#pragma once

#include <string>
#include <utility>

struct GLFWwindow;

namespace grav {

class Window {
public:
    struct Config {
        int width;
        int height;
        std::string title;
        bool vsync;
        int gl_major;
        int gl_minor;
    };

    explicit Window(const Config& cfg);
    ~Window();

    Window(const Window&) = delete;
    Window& operator=(const Window&) = delete;
    Window(Window&&) = delete;
    Window& operator=(Window&&) = delete;

    [[nodiscard]] bool should_close() const;
    void poll_events();
    void swap_buffers();

    [[nodiscard]] GLFWwindow* handle() const noexcept { return handle_; }
    [[nodiscard]] std::pair<int, int> framebuffer_size() const;
    [[nodiscard]] std::pair<int, int> window_size() const;
    [[nodiscard]] float dpi_scale() const;

private:
    GLFWwindow* handle_ = nullptr;
};

}
