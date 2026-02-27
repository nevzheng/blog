export const SITE = {
  website: "https://nevzheng.github.io/blog/",
  author: "Nevin Zheng",
  profile: "https://github.com/nevzheng",
  desc: "Project notes and things I'm learning.",
  title: "nevzheng",
  ogImage: "astropaper-og.jpg",
  lightAndDarkMode: true,
  postPerIndex: 4,
  postPerPage: 4,
  scheduledPostMargin: 15 * 60 * 1000, // 15 minutes
  showArchives: true,
  showBackButton: true,
  editPost: {
    enabled: false,
    text: "Edit page",
    url: "https://github.com/nevzheng/blog/edit/main/",
  },
  dynamicOgImage: true,
  dir: "ltr",
  lang: "en",
  timezone: "America/Los_Angeles",
} as const;
