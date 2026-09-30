var COLUMNS = [
    { key: 'title', label: 'Title' },
    { key: 'rating', label: 'Rating' },
    { key: 'reviewCount', label: 'Reviews' },
    { key: 'phone', label: 'Phone' },
    { key: 'industry', label: 'Industry' },
    { key: 'address', label: 'Address' },
    { key: 'companyUrl', label: 'Website' },
    { key: 'email', label: 'Email' },
    { key: 'instagram', label: 'Instagram' },
    { key: 'facebook', label: 'Facebook' },
    { key: 'linkedin', label: 'LinkedIn' },
    { key: 'href', label: 'Google Maps Link' }
];

var allResults = [];

document.addEventListener('DOMContentLoaded', function() {
    chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        var currentTab = tabs[0];
        var actionButton = document.getElementById('actionButton');
        var downloadCsvButton = document.getElementById('downloadCsvButton');
        var findEmailsButton = document.getElementById('findEmailsButton');
        var resultsTable = document.getElementById('resultsTable');
        var filenameInput = document.getElementById('filenameInput');
        var filterInputs = ['minRating', 'minReviews', 'hasPhone', 'noWebsite'].map(function(id) {
            return document.getElementById(id);
        });

        if (currentTab && currentTab.url.includes("://www.google.com/maps/search")) {
            document.getElementById('message').textContent = "Let's scrape Google Maps!";
            actionButton.disabled = false;
            actionButton.classList.add('enabled');
        } else {
            var messageElement = document.getElementById('message');
            messageElement.innerHTML = '';
            var linkElement = document.createElement('a');
            linkElement.href = 'https://www.google.com/maps/search/';
            linkElement.textContent = "Go to Google Maps Search.";
            linkElement.target = '_blank'; 
            messageElement.appendChild(linkElement);

            actionButton.style.display = 'none'; 
        }

        // Restore the last results, so closing the popup doesn't lose them
        chrome.storage.local.get('results', function(data) {
            if (data && Array.isArray(data.results) && data.results.length) {
                allResults = data.results;
                refresh();
            }
        });

        filterInputs.forEach(function(input) {
            input.addEventListener('input', refresh);
            input.addEventListener('change', refresh);
        });

        actionButton.addEventListener('click', function() {
            chrome.scripting.executeScript({
                target: {tabId: currentTab.id},
                function: scrapeData
            }, function(results) {
                if (!results || !results[0] || !results[0].result) return;
                allResults = results[0].result.map(function(item) {
                    item.reviewCount = (item.reviewCount || '').replace(/\(|\)/g, '');
                    item.companyUrl = cleanWebsite(item.companyUrl);
                    item.email = '';
                    item.instagram = '';
                    item.facebook = '';
                    item.linkedin = '';
                    return item;
                });
                saveResults();
                refresh();
            });
        });

        findEmailsButton.addEventListener('click', function() {
            // Ask for access to websites only when this feature is used
            chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }, function(granted) {
                if (!granted) {
                    setStatus('Website access is needed to find emails and social links.');
                    return;
                }
                findEmailsAndSocials();
            });
        });

        downloadCsvButton.addEventListener('click', function() {
            var csv = tableToCsv(resultsTable); 
            var filename = filenameInput.value.trim();
            if (!filename) {
                filename = 'google-maps-data.csv'; 
            } else {
                filename = filename.replace(/[^a-z0-9]/gi, '_').toLowerCase() + '.csv';
            }
            downloadCsv(csv, filename); 
        });

        function refresh() {
            var shown = renderTable(resultsTable, filterResults(allResults));
            downloadCsvButton.disabled = shown === 0;
            findEmailsButton.disabled = !allResults.some(function(item) { return item.companyUrl; });
            if (allResults.length) {
                setStatus('Showing ' + shown + ' of ' + allResults.length + ' businesses. Download exports only the rows shown.');
            }
        }

        function findEmailsAndSocials() {
            var todo = allResults.filter(function(item) { return item.companyUrl && !item.checked; });
            var done = 0;
            var next = 0;
            findEmailsButton.disabled = true;
            actionButton.disabled = true;
            setStatus('Checking websites: 0 of ' + todo.length + '... keep this popup open.');

            function worker() {
                if (next >= todo.length) return Promise.resolve();
                var item = todo[next++];
                return getContactInfo(item.companyUrl).then(function(info) {
                    item.email = info.emails.join('; ');
                    item.instagram = info.instagram;
                    item.facebook = info.facebook;
                    item.linkedin = info.linkedin;
                    item.checked = true;
                }).catch(function() {
                    item.checked = true;
                }).then(function() {
                    done++;
                    saveResults();
                    refresh();
                    setStatus('Checking websites: ' + done + ' of ' + todo.length + '... keep this popup open.');
                    return worker();
                });
            }

            // Check 4 websites at a time
            var workers = [];
            for (var i = 0; i < 4; i++) workers.push(worker());
            Promise.all(workers).then(function() {
                actionButton.disabled = false;
                refresh();
                var found = allResults.filter(function(item) { return item.email; }).length;
                setStatus('Done. Found emails for ' + found + ' of ' + allResults.length + ' businesses.');
            });
        }
    });
});

function setStatus(text) {
    document.getElementById('status').textContent = text;
}

function saveResults() {
    chrome.storage.local.set({ results: allResults });
}

function filterResults(results) {
    var minRating = parseFloat(document.getElementById('minRating').value) || 0;
    var minReviews = parseInt(document.getElementById('minReviews').value, 10) || 0;
    var hasPhone = document.getElementById('hasPhone').checked;
    var noWebsite = document.getElementById('noWebsite').checked;

    return results.filter(function(item) {
        var rating = parseFloat(item.rating) || 0;
        var reviews = parseInt((item.reviewCount || '').replace(/\D/g, ''), 10) || 0;
        if (rating < minRating) return false;
        if (reviews < minReviews) return false;
        if (hasPhone && !item.phone) return false;
        if (noWebsite && item.companyUrl) return false;
        return true;
    });
}

function renderTable(table, results) {
    while (table.firstChild) {
        table.removeChild(table.firstChild);
    }

    var headerRow = document.createElement('tr');
    COLUMNS.forEach(function(column) {
        var header = document.createElement('th');
        header.textContent = column.label;
        headerRow.appendChild(header);
    });
    table.appendChild(headerRow);

    results.forEach(function(item) {
        var row = document.createElement('tr');
        COLUMNS.forEach(function(column) {
            var cell = document.createElement('td');
            cell.textContent = item[column.key] || '';
            cell.title = cell.textContent;
            row.appendChild(cell);
        });
        table.appendChild(row);
    });
    return results.length;
}

// Google sometimes wraps websites as google.com/url?q=...; unwrap those and
// drop links that point back to Google itself (not a real website)
function cleanWebsite(url) {
    if (!url) return '';
    try {
        var parsed = new URL(url);
        if (/(^|\.)google\./.test(parsed.hostname)) {
            var target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
            return target && /^https?:\/\//.test(target) ? cleanWebsite(target) : '';
        }
        return url;
    } catch (e) {
        return '';
    }
}

// Fetch a page with a time limit and parse it as HTML
function fetchPage(url) {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 10000);
    return fetch(url, { signal: controller.signal, credentials: 'omit' }).then(function(response) {
        clearTimeout(timer);
        var type = response.headers.get('content-type') || '';
        if (!response.ok || type.indexOf('html') === -1) throw new Error('Not an HTML page');
        return response.text().then(function(html) {
            return { url: response.url || url, doc: new DOMParser().parseFromString(html, 'text/html'), html: html };
        });
    }, function(error) {
        clearTimeout(timer);
        throw error;
    });
}

// Visit the website's home page (and its contact/about page if needed) and
// collect email addresses and Instagram, Facebook and LinkedIn links
function getContactInfo(website) {
    var info = { emails: [], instagram: '', facebook: '', linkedin: '' };
    var visited = {};

    function scan(page) {
        visited[page.url.replace(/#.*$/, '')] = true;
        extractEmails(page).forEach(function(email) {
            if (info.emails.indexOf(email) === -1) info.emails.push(email);
        });
        Array.from(page.doc.querySelectorAll('a[href]')).forEach(function(a) {
            var href = a.getAttribute('href') || '';
            if (!info.instagram && /^https?:\/\/(www\.)?instagram\.com\/(?!p\/|reel\/|explore\/|share)[\w.]+/i.test(href)) info.instagram = href;
            if (!info.facebook && /^https?:\/\/(www\.|m\.|web\.)?(facebook|fb)\.com\/(?!sharer|share|dialog|plugins|tr\b)[^\s]+/i.test(href)) info.facebook = href;
            if (!info.linkedin && /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\/(company|in|school)\/[^\s]+/i.test(href)) info.linkedin = href;
        });
    }

    return fetchPage(website).then(function(home) {
        scan(home);
        if (info.emails.length) return info;

        // No email on the home page: try up to 2 contact/about pages on the same site
        var host = new URL(home.url).hostname;
        var candidates = [];
        Array.from(home.doc.querySelectorAll('a[href]')).forEach(function(a) {
            var text = (a.textContent + ' ' + a.getAttribute('href')).toLowerCase();
            if (!/contact|about|reach|get-in-touch/.test(text)) return;
            try {
                var url = new URL(a.getAttribute('href'), home.url);
                url.hash = '';
                if (url.hostname === host && !visited[url.href] && candidates.indexOf(url.href) === -1) {
                    candidates.push(url.href);
                }
            } catch (e) {}
        });

        return candidates.slice(0, 2).reduce(function(chain, url) {
            return chain.then(function() {
                if (info.emails.length) return;
                return fetchPage(url).then(scan, function() {});
            });
        }, Promise.resolve()).then(function() { return info; });
    });
}

function extractEmails(page) {
    var found = [];

    // mailto: links
    Array.from(page.doc.querySelectorAll('a[href^="mailto:" i]')).forEach(function(a) {
        found.push(decodeURIComponent(a.getAttribute('href').slice(7).split('?')[0]));
    });

    // Cloudflare-protected emails
    Array.from(page.doc.querySelectorAll('[data-cfemail]')).forEach(function(el) {
        var encoded = el.getAttribute('data-cfemail');
        var key = parseInt(encoded.substr(0, 2), 16);
        var email = '';
        for (var i = 2; i < encoded.length; i += 2) {
            email += String.fromCharCode(parseInt(encoded.substr(i, 2), 16) ^ key);
        }
        found.push(email);
    });

    // Emails written in the page text or HTML
    var text = (page.doc.body ? page.doc.body.textContent : '') + ' ' + page.html;
    found = found.concat(text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []);

    var unique = [];
    found.forEach(function(email) {
        email = email.trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z]+$/g, '');
        if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email)) return;
        if (/\.(png|jpe?g|gif|svg|webp|css|js)$/.test(email)) return;
        if (/(example\.|sentry|wixpress|domain\.com|email\.com|yourdomain|@2x)/.test(email)) return;
        if (unique.indexOf(email) === -1) unique.push(email);
    });
    return unique.slice(0, 3);
}



function scrapeData() {
    var links = Array.from(document.querySelectorAll('a[href^="https://www.google.com/maps/place"]'));
    return links.map(link => {
        var container = link.closest('[jsaction*="mouseover:pane"]');
        var titleText = container ? container.querySelector('.fontHeadlineSmall').textContent : '';
        var rating = '';
        var reviewCount = '';
        var phone = '';
        var industry = '';
        var address = '';
        var companyUrl = '';

        // Rating and Reviews
        if (container) {
            var roleImgContainer = container.querySelector('[role="img"]');
            
            if (roleImgContainer) {
                var ariaLabel = roleImgContainer.getAttribute('aria-label');
            
                if (ariaLabel && ariaLabel.includes("stars")) {
                    var parts = ariaLabel.split(' ');
                    var rating = parts[0];
                    var reviewCount = '(' + parts[2] + ')'; 
                } else {
                    rating = '0';
                    reviewCount = '0';
                }
            }
        }

        // Info lines of the result card, each split on the "·" separator, e.g.
        //   ["Chartered accountant", "A-309 Privilon, Ambli Rd"]
        //   ["Closed", "Opens 10 am", "090168 75077"]
        var infoLines = [];
        if (container) {
            Array.from(container.querySelectorAll('.W4Efsd')).forEach(function(line) {
                if (line.querySelector('.W4Efsd') || line.querySelector('[role="img"]')) return;
                var segments = (line.textContent || '').split(/[·⋅]/).map(function(s) {
                    return s.replace(/\s+/g, ' ').trim();
                }).filter(function(s) { return s; });
                if (segments.length) infoLines.push(segments);
            });
        }

        // Phone Numbers (any country format and length, leading zeros kept)
        if (container) {
            var phoneEl = container.querySelector('.UsdlK');
            if (phoneEl && isPhoneNumber(phoneEl.textContent.trim())) {
                phone = phoneEl.textContent.trim();
            }
            if (!phone) {
                infoLines.some(function(segments) {
                    phone = segments.find(isPhoneNumber) || '';
                    return phone;
                });
            }
            if (!phone) {
                var phoneMatches = (container.textContent || '').match(/\+?\(?\d[\d\s().-]{5,}\d/g) || [];
                phone = phoneMatches.map(function(m) { return m.trim(); }).find(isPhoneNumber) || '';
            }
        }

        // Industry and Address
        if (container) {
            var detailLine = infoLines.find(function(segments) {
                return !segments.some(function(segment) {
                    return isPhoneNumber(segment) || /^(Open|Closed|Opens|Closes|Temporarily closed|Permanently closed)\b/i.test(segment);
                });
            });
            if (detailLine) {
                industry = detailLine[0];
                if (detailLine.length > 1) {
                    address = detailLine[detailLine.length - 1];
                }
            } else {
                // Fallback: text-based parsing, with the phone number removed
                // so it can't be mistaken for an address
                var containerText = container.textContent || '';
                if (phone) {
                    containerText = containerText.split(phone).join(' ');
                }
                var addressRegex = /\d+ [\w\s]+(?:#\s*\d+|Suite\s*\d+|Apt\s*\d+)?/;
                var addressMatch = containerText.match(addressRegex);

                if (addressMatch) {
                    address = addressMatch[0];

                    // Extract industry text based on the position before the address
                    var textBeforeAddress = containerText.substring(0, containerText.indexOf(address)).trim();
                    var ratingIndex = textBeforeAddress.lastIndexOf(rating + reviewCount);
                    if (ratingIndex !== -1) {
                        // Assuming industry is the first significant text after rating and review count
                        var rawIndustryText = textBeforeAddress.substring(ratingIndex + (rating + reviewCount).length).trim().split(/[\r\n]+/)[0];
                        industry = rawIndustryText.replace(/[·.,#!?]/g, '').trim();
                    }
                    var filterRegex = /\b(Closed|Open 24 hours|24 hours)|Open\b/g;
                    address = address.replace(filterRegex, '').trim();
                    address = address.replace(/(\d+)(Open)/g, '$1').trim();
                    address = address.replace(/(\w)(Open)/g, '$1').trim();
                    address = address.replace(/(\w)(Closed)/g, '$1').trim();
                }
            }
        }

        // Company URL
        if (container) {
            var allLinks = Array.from(container.querySelectorAll('a[href]'));
            var filteredLinks = allLinks.filter(a => !a.href.startsWith("https://www.google.com/maps/place/"));
            if (filteredLinks.length > 0) {
                companyUrl = filteredLinks[0].href;
            }
        }

        // Return the data as an object
        return {
            title: titleText,
            rating: rating,
            reviewCount: reviewCount,
            phone: phone,
            industry: industry,
            address: address,
            companyUrl: companyUrl,
            href: link.href,
        };
    });

    // A phone number: optional "+", then digits with spaces, dashes, dots or
    // parentheses. 7-15 digits (the international maximum), so leading zeros
    // and long numbers like "090168 75077" or "+91 98765 43210" stay whole.
    function isPhoneNumber(text) {
        if (!/^\+?[\d\s().-]+$/.test(text)) return false;
        if (/^\d+\.\d+\s*\(/.test(text)) return false; // rating like "4.9(312)"
        var digits = text.replace(/\D/g, '');
        return digits.length >= 7 && digits.length <= 15;
    }
}

// Convert the table to a CSV string
function tableToCsv(table) {
    var csv = [];
    var rows = table.querySelectorAll('tr');
    var phoneColumn = COLUMNS.map(function(column) { return column.key; }).indexOf('phone');
    
    for (var i = 0; i < rows.length; i++) {
        var row = [], cols = rows[i].querySelectorAll('td, th');
        
        for (var j = 0; j < cols.length; j++) {
            var value = (cols[j].textContent || '').trim();
            // Write phone numbers as text so Excel/Sheets keep the leading zero
            if (cols[j].tagName === 'TD' && j === phoneColumn && value) {
                value = '="' + value + '"';
            }
            row.push('"' + value.replace(/"/g, '""') + '"');
        }
        csv.push(row.join(','));
    }
    return csv.join('\r\n');
}
// Download the CSV file
function downloadCsv(csv, filename) {
    var csvFile;
    var downloadLink;

    // UTF-8 BOM so Excel shows characters like "–" correctly
    csvFile = new Blob(['﻿' + csv], {type: 'text/csv;charset=utf-8'});
    downloadLink = document.createElement('a');
    downloadLink.download = filename;
    downloadLink.href = window.URL.createObjectURL(csvFile);
    downloadLink.style.display = 'none';
    document.body.appendChild(downloadLink);
    downloadLink.click();
}
