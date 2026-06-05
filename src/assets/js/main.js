import { createApp } from "vue";
import App from "../../App.vue";
import Swiper from "swiper";
import { Navigation, Pagination } from "swiper/modules";
import "swiper/css";
import "swiper/css/navigation";
import "swiper/css/pagination";

createApp(App).mount("#app");

const sampleSwiper = document.querySelector(".js-sample-swiper");

if (sampleSwiper) {
  new Swiper(sampleSwiper, {
    modules: [Navigation, Pagination],
    loop: true,
    slidesPerView: 1,
    spaceBetween: 24,
    pagination: {
      el: ".swiper-pagination",
      clickable: true,
    },
    navigation: {
      nextEl: ".swiper-button-next",
      prevEl: ".swiper-button-prev",
    },
  });
}
